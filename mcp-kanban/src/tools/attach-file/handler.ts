import { createHash } from 'node:crypto';
import type { PlaneClient } from '../../plane-client.js';
import type { MinioClient } from '../../minio-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import { mcaIdFromObjectKey } from '../../attachments/types.js';
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
  upload_url: string;
  method: 'PUT';
  /** Подсказка по заголовкам: Content-Type не входит в подпись, но агент
   *  обычно хочет проставить его при PUT. */
  required_headers: Record<string, string>;
  object_key: string;
  /** Сколько секунд URL валиден. */
  expires_in: number;
}

export interface CompleteResult {
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

export async function attachFile(deps: {
  plane: PlaneClient;
  minio: MinioClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  identity: AgentIdentity;
  /** MinIO bucket для агент-артефактов (MCP_*). */
  bucket: string;
  /** TTL presigned URL'ов в секундах. */
  expiresInSec: number;
  input: AttachFileInput;
}): Promise<PresignResult | CompleteResult> {
  const parsed = parseIssueRef(deps.input.issue_id);
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

  if (deps.input.complete === true) {
    if (deps.input.object_key === undefined) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: 'complete=true requires object_key (returned from the presign phase)',
      });
    }
    const objectKey = deps.input.object_key;
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
    const note = deps.input.note !== undefined ? ` — ${deps.input.note}` : '';
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
  const objectKey = makeObjectKey(deps.identity, deps.input.filename, issueId);
  const uploadUrl = await deps.minio.presignedPutObject(deps.bucket, objectKey, deps.expiresInSec);
  return {
    kind: 'presign',
    upload_url: uploadUrl,
    method: 'PUT',
    required_headers: { 'Content-Type': deps.input.mime_type },
    object_key: objectKey,
    expires_in: deps.expiresInSec,
  };
}

function makeObjectKey(identity: AgentIdentity, filename: string, issueId: string): string {
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
