import { createHash } from 'node:crypto';
import type { PlaneClient } from '../../plane-client.js';
import type { MinioClient } from '../../minio-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import { McpError } from '../../errors.js';
import { mcaIdFromObjectKey } from '../../attachments/types.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveProject } from '../project-resolver.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import type { AttachFileInput } from './schema.js';

// `attach_file` — двухфазная операция (SPEC §6.2), реализованная поверх
// реального MinIO presign (SLONK-18):
//
//   1) Без `complete=true` — выдаём НАСТОЯЩИЙ presigned PUT URL
//      (`minio.presignedPutObject`). Агент делает `PUT <upload_url>` с телом
//      файла напрямую в bucket агент-артефактов. Авторизация — в query-подписи,
//      обязательных заголовков нет (Content-Type — опциональная подсказка).
//   2) С `complete=true` и `object_key` — подтверждаем аплоад:
//      `statObject` проверяет, что файл реально лёг (контракт «complete OK →
//      файл на месте»), затем регистрируем его как mcp-artifact (он живёт под
//      префиксом `issues/<id>/`, поэтому виден через `list_attachments` и
//      резолвится `read_attachment` по стабильному `mca_`-id) и постим
//      аннотацию-комментарий. Это закрывает прикрепление и к задаче (артефакт),
//      и к комментарию (аннотация со ссылкой на artifact-id).

export interface PresignResult {
  kind: 'presign';
  issue_id: string;
  object_key: string;
  upload_url: string;
  method: 'PUT';
  /** Подсказка по заголовкам: Content-Type не входит в подпись, но агент
   *  обычно хочет проставить его при PUT. */
  required_headers: Record<string, string>;
  /** Сколько секунд URL валиден. */
  expires_in: number;
};

export type CompleteResult = {
  kind: 'complete';
  issue_id: string;
  object_key: string;
  /** Стабильный id артефакта — резолвится `read_attachment(attachment_id)`. */
  attachment_id: string;
  filename: string;
  mime_type: string;
  size: number;
  /** Свежий presigned GET для удобства вызывающего (в комментарий НЕ пишется —
   *  туда идёт только стабильный artifact-id, чтобы не плодить протухающие
   *  ссылки и не оставлять X-Amz-Signature в истории задачи). */
  download_url: string;
  comment_id: string;
}

export type DirectUploadResult = {
  kind: 'direct';
  issue_id: string;
  object_key: string;
  /** Стабильный id артефакта — резолвится `read_attachment(attachment_id)`.
   *  Симметрично complete-результату (SLONK-31, A3). */
  attachment_id: string;
  /** Свежий presigned GET для удобства вызывающего. В комментарий-аннотацию
   *  НЕ пишется — туда идёт только стабильный mca_-id. */
  download_url: string;
  size: number;
  attachment: {
    source: 'mcp_artifact';
    filename: string;
    mime_type: string;
    size: number;
    uploaded_by: AgentIdentity;
  };
};

export interface AttachFileDeps {
  plane: PlaneClient;
  minio: MinioClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  identity: AgentIdentity;
  bucket: string;
  /** TTL presigned URL'ов в секундах. */
  expiresInSec: number;
  /** Максимальный размер decoded direct-аплоада (MCP_ATTACH_MAX_BYTES). */
  maxBytes: number;
  /** MIME-allowlist для direct (MCP_ATTACH_ALLOWED_MIME). Пусто = любые. */
  allowedMime: string[];
  input: AttachFileInput;
}

export async function attachFile(deps: AttachFileDeps): Promise<PresignResult | CompleteResult | DirectUploadResult> {
  const parsed = parseIssueRef(String(deps.input.issue_id));
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined
      ? { projectRef: deps.input.project }
      : parsed.kind === 'sequence' && parsed.identifier !== undefined
        ? { projectRef: parsed.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });
  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsed);

  if (deps.input.content_base64) {
    if (deps.input.size > deps.maxBytes) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `direct upload size exceeds the configured limit (${deps.maxBytes} bytes)`,
      });
    }
    // MIME-allowlist (A5): пустой список = разрешены любые типы (backward
    // compat); непустой — отвергаем всё, чего в нём нет.
    if (deps.allowedMime.length > 0 && !deps.allowedMime.includes(deps.input.mime_type)) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `mime_type '${deps.input.mime_type}' is not in the allowed list`,
      });
    }
    const objectKey = makeObjectKey(issueId, deps.identity, deps.input.filename);
    const content = decodeBase64(deps.input.content_base64);
    if (content.byteLength !== deps.input.size) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `content_base64 decodes to ${content.byteLength} bytes`,
      });
    }

    await deps.minio.putObject(deps.bucket, objectKey, content, content.byteLength, {
      'Content-Type': deps.input.mime_type,
    });

    // Симметрично complete (A3): стабильный mca_-id + свежий download_url.
    const attachmentId = mcaIdFromObjectKey(objectKey, sha1);
    const downloadUrl = await deps.minio.presignedGetObject(deps.bucket, objectKey, deps.expiresInSec);
    await createAttachmentComment(deps, project.id, issueId, attachmentId);
    deps.cache.clear();

    return {
      kind: 'direct',
      issue_id: issueId,
      object_key: objectKey,
      attachment_id: attachmentId,
      download_url: downloadUrl,
      size: content.byteLength,
      attachment: {
        source: 'mcp_artifact',
        filename: deps.input.filename,
        mime_type: deps.input.mime_type,
        size: content.byteLength,
        uploaded_by: deps.identity,
      },
    };
  }

  if (deps.input.complete) {
    const objectKey = deps.input.object_key;
    if (objectKey === undefined) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: 'complete=true requires object_key (returned from the presign phase)',
      });
    }
    // Защита от подмены чужого/произвольного ключа: complete принимает только
    // ключи под префиксом этой задачи (тот же неймспейс, что выдаёт presign).
    const expectedPrefix = `issues/${issueId}/`;
    if (!objectKey.startsWith(expectedPrefix)) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `object_key must live under '${expectedPrefix}' for issue ${issueId}`,
      });
    }

    // Контракт «complete OK → файл на месте»: 404 → NOT_FOUND
    // («сначала загрузите файл на upload_url»).
    const stat = await deps.minio.statObject(deps.bucket, objectKey);
    const attachmentId = mcaIdFromObjectKey(objectKey, sha1);
    const downloadUrl = await deps.minio.presignedGetObject(deps.bucket, objectKey, deps.expiresInSec);

    const size = stat.size > 0 ? stat.size : deps.input.size;
    const mimeType = stat.contentType ?? deps.input.mime_type;
    const note = deps.input.note !== undefined ? ` — ${deps.input.note}` : "";
    const comment = await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
      comment_html: formatComment(
        deps.identity,
        `attached <code>${escapeHtml(deps.input.filename)}</code> (${size} bytes), ` +
          `attachment id <code>${attachmentId}</code> — resolve via read_attachment${escapeHtml(note)}`,
      ),
    });
    deps.cache.clear();
    return {
      kind: 'complete',
      issue_id: issueId,
      object_key: objectKey,
      attachment_id: attachmentId,
      filename: deps.input.filename,
      mime_type: mimeType,
      size,
      download_url: downloadUrl,
      comment_id: comment.id,
    };
  }

  // Presign phase: реальный подписанный PUT URL через MinIO.
  const objectKey = makeObjectKey(issueId, deps.identity, deps.input.filename);
  const uploadUrl = await deps.minio.presignedPutObject(deps.bucket, objectKey, deps.expiresInSec);
  return {
    kind: 'presign',
    issue_id: issueId,
    upload_url: uploadUrl,
    method: 'PUT',
    required_headers: { 'Content-Type': deps.input.mime_type },
    object_key: objectKey,
    expires_in: deps.expiresInSec,
  };
}

async function createAttachmentComment(
  deps: AttachFileDeps,
  projectId: string,
  issueId: string,
  attachmentId: string,
): Promise<void> {
  // A4: аннотация унифицирована на стабильный mca_-id (раньше писался сырой
  // object_key) и резолвится через read_attachment — симметрично complete.
  // filename/note приходят от агента, поэтому экранируем перед вставкой в HTML.
  const note = deps.input.note !== undefined ? ` — ${escapeHtml(deps.input.note)}` : '';
  await deps.plane.createIssueComment(deps.workspace, projectId, issueId, {
    comment_html: formatComment(
      deps.identity,
      `attached <code>${escapeHtml(deps.input.filename)}</code> (${deps.input.size} bytes), ` +
        `attachment id <code>${attachmentId}</code> — resolve via read_attachment${note}`,
    ),
  });
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new McpError({ code: 'INVALID_INPUT', message: 'content_base64 must be valid standard base64' });
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64') !== normalized) {
    throw new McpError({ code: 'INVALID_INPUT', message: 'content_base64 must be canonical standard base64' });
  }
  return decoded;
}

function makeObjectKey(issueId: string, identity: AgentIdentity, filename: string): string {
  const ts = Date.now();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `issues/${issueId}/${ts}-${identity}-${safe}`;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** Минимальный HTML-escape для значений, которые мы вставляем в comment_html.
 *  (comment-issue.formatComment санитайзит тело целиком, но attach_file строит
 *  HTML вручную с <code>/<a>, поэтому экранируем пользовательские куски сами.) */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
