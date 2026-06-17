import type { PlaneClient } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import type { MinioClient } from '../../minio-client.js';
import { McpError } from '../../errors.js';
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
        message: 'complete=true requires object_key (returned from presign phase)',
      });
    }
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
