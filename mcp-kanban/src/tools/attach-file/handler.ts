import { createHash } from 'node:crypto';
import type { PlaneClient } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import type { MinioClient } from '../../minio-client.js';
import { McpError } from '../../errors.js';
import { mcaIdFromObjectKey, type PublicAttachment } from '../../attachments/types.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import type { AttachFileInput } from './schema.js';

// `attach_file` — двухфазная операция (см. SPEC §6.2):
//
//   1) Без `complete=true` — создаём object_key и отдаём настоящий SigV4
//      presigned PUT URL через public MinIO endpoint.
//   2) С `complete=true` и `object_key` — проверяем, что объект уже лежит в
//      MinIO, и публикуем в комментарии временную presigned GET ссылку.

export interface PresignResult {
  kind: 'presign';
  upload_url: string;
  method: 'PUT' | 'POST';
  required_headers: Record<string, string>;
  object_key: string;
  /** Сколько секунд URL валиден. */
  expires_in: number;
}

export interface CompleteResult {
  kind: 'complete';
  issue_id: string;
  object_key: string;
}

export interface DirectUploadResult {
  kind: 'direct';
  issue_id: string;
  object_key: string;
  size: number;
  attachment: PublicAttachment;
}

const DIRECT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export async function attachFile(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  identity: AgentIdentity;
  /** MinIO bucket для агент-артефактов (MCP_*). */
  bucket: string;
  minio: MinioClient;
  /** TTL presigned (MCP_PLANE_TIMEOUT… не подходит, отдельный SPEC). */
  expiresInSec: number;
  input: AttachFileInput;
}): Promise<PresignResult | CompleteResult | DirectUploadResult> {
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
    if (deps.input.size > DIRECT_UPLOAD_MAX_BYTES) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `direct upload size exceeds ${DIRECT_UPLOAD_MAX_BYTES} bytes`,
      });
    }
    const objectKey = makeObjectKey(deps.identity, deps.input.filename, issueId);
    const content = decodeBase64(deps.input.content_base64);
    if (content.byteLength !== deps.input.size) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `content_base64 decodes to ${content.byteLength} bytes, expected size ${deps.input.size}`,
      });
    }

    await deps.minio.putObject(deps.bucket, objectKey, content, content.byteLength, {
      'Content-Type': deps.input.mime_type,
    });
    await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
      comment_html: formatComment(
        deps.identity,
        `attached <code>${deps.input.filename}</code> (${deps.input.size} bytes) as <code>${objectKey}</code>`,
      ),
    });
    deps.cache.clear();

    return {
      kind: 'direct',
      issue_id: issueId,
      object_key: objectKey,
      size: content.byteLength,
      attachment: {
        id: mcaIdFromObjectKey(objectKey, sha1),
        source: 'mcp_artifact',
        filename: deps.input.filename,
        mime_type: deps.input.mime_type,
        size: content.byteLength,
        uploaded_at: new Date().toISOString(),
        uploaded_by: deps.identity,
      },
    };
  }

  if (deps.input.complete === true) {
    if (deps.input.object_key === undefined) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: 'complete=true requires object_key (returned from presign phase)',
      });
    }
    ensureObjectKeyBelongsToIssue(deps.input.object_key, issueId);
    await deps.minio.statObject(deps.bucket, deps.input.object_key);
    const url = await deps.minio.presignedGetObject(
      deps.bucket,
      deps.input.object_key,
      deps.expiresInSec,
    );
    await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
      comment_html: formatComment(
        deps.identity,
        `attached <code>${deps.input.filename}</code> (${deps.input.size} bytes) → <a href="${url}">${url}</a>`,
      ),
    });
    deps.cache.clear();
    return { kind: 'complete', issue_id: issueId, object_key: deps.input.object_key };
  }

  // Presign phase: deterministic object key + real SigV4 presigned PUT URL.
  const objectKey = makeObjectKey(deps.identity, deps.input.filename, issueId);
  await deps.minio.ensureBucket(deps.bucket);
  const uploadUrl = await deps.minio.presignedPutObject(
    deps.bucket,
    objectKey,
    deps.expiresInSec,
  );
  return {
    kind: 'presign',
    upload_url: uploadUrl,
    method: 'PUT',
    required_headers: {},
    object_key: objectKey,
    expires_in: deps.expiresInSec,
  };
}

function makeObjectKey(identity: AgentIdentity, filename: string, issueId: string): string {
  const ts = Date.now();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `issues/${issueId}/${ts}-${identity}-${safe}`;
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

function ensureObjectKeyBelongsToIssue(objectKey: string, issueId: string): void {
  const expectedPrefix = `issues/${issueId}/`;
  if (!objectKey.startsWith(expectedPrefix)) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: 'object_key must be the key returned by attach_file presign for this issue',
    });
  }
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}
