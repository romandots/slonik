import type { PlaneClient } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import type { AttachFileInput } from './schema.js';

// `attach_file` — двухфазная операция (см. SPEC §6.2). v1: Plane API
// v1.3.0 поддерживает `/issues/{id}/attachments/` с
// multipart upload, но не выдаёт собственный presigned-URL. Чтобы остаться
// в спецификации MCP, реализуем минимально:
//
//   1) Без `complete=true` — отдаём ссылку на endpoint Plane'а, через
//      который агент пройдёт multipart upload. Это не настоящий S3
//      presign, но контрактно совместимо: агенту достаточно URL + методу.
//   2) С `complete=true` и `object_key` — публикуем комментарий с ссылкой
//      и помечаем issue. Чистая реализация MinIO-presign относится к
//      Phase 7 (proxy + TLS + S3-policy), здесь — stub.

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

export async function attachFile(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  identity: AgentIdentity;
  /** MinIO bucket для агент-артефактов (MCP_*). */
  bucket: string;
  /** Внутренний MinIO endpoint, чтобы агент мог загружать напрямую. */
  endpoint: string;
  /** TTL presigned (MCP_PLANE_TIMEOUT… не подходит, отдельный SPEC). */
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
    allowedProjects: deps.allowedProjects,
  });
  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsed);

  if (deps.input.complete === true) {
    if (deps.input.object_key === undefined) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: 'complete=true requires object_key (returned from presign phase)',
      });
    }
    const url = `${deps.endpoint.replace(/\/$/, '')}/${deps.bucket}/${deps.input.object_key}`;
    await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
      comment_html: formatComment(
        deps.identity,
        `attached <code>${deps.input.filename}</code> (${deps.input.size} bytes) → <a href="${url}">${url}</a>`,
      ),
    });
    deps.cache.clear();
    return { kind: 'complete', issue_id: issueId, object_key: deps.input.object_key };
  }

  // Presign phase. v1 stub: deterministic object key, payload-based URL.
  // Реальный S3 presign — Phase 7 (использует aws4-fetch / minio.presignedPutObject).
  const objectKey = makeObjectKey(deps.identity, deps.input.filename, issueId);
  const uploadUrl = `${deps.endpoint.replace(/\/$/, '')}/${deps.bucket}/${objectKey}`;
  return {
    kind: 'presign',
    upload_url: uploadUrl,
    method: 'PUT',
    required_headers: {
      'Content-Type': deps.input.mime_type,
      'X-Slonk-Identity': deps.identity,
    },
    object_key: objectKey,
    expires_in: deps.expiresInSec,
  };
}

function makeObjectKey(identity: AgentIdentity, filename: string, issueId: string): string {
  const ts = Date.now();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `issues/${issueId}/${ts}-${identity}-${safe}`;
}
