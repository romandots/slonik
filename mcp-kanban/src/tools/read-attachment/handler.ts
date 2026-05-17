import { createHash } from 'node:crypto';
import type { PlaneClient } from '../../plane-client.js';
import type { MinioClient } from '../../minio-client.js';
import type { TtlCache } from '../../cache.js';
import type { Logger } from '../../logger.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { extractInlineAssets } from '../../attachments/comment-assets.js';
import { parseAttachmentId, type Attachment, type AttachmentSource } from '../../attachments/types.js';
import type { ReadAttachmentInput } from './schema.js';

export interface ReadAttachmentResult {
  download_url: string;
  method: 'GET';
  required_headers: Record<string, string>;
  expires_in: number;
  mime_type: string;
  size: number;
  filename: string;
  source: AttachmentSource;
  /** Аудит-метадата (без presigned URL) — попадает в audit_log.metadata. */
  audit: {
    bucket: string;
    object_key: string;
    expires_at: string;
  };
}

export async function readAttachment(deps: {
  plane: PlaneClient;
  minio: MinioClient;
  cache: TtlCache;
  logger: Logger;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  planeBucket: string;
  mcpBucket: string;
  minioEndpoints: string[];
  expiresInSec: number;
  input: ReadAttachmentInput;
}): Promise<ReadAttachmentResult> {
  // 1) Валидация id (зод-схема уже проверила prefix; parseAttachmentId
  // дополнительно проверяет внутренний формат payload).
  const parsedId = parseAttachmentId(deps.input.attachment_id);

  // 2) Резолв issue+project (нужен для scoping discovery).
  const parsedIssue = parseIssueRef(deps.input.issue_id);
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined
      ? { projectRef: deps.input.project }
      : parsedIssue.kind === 'sequence' && parsedIssue.identifier !== undefined
        ? { projectRef: parsedIssue.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });
  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsedIssue);

  // 3) Reverse-resolution id → Attachment (stateless, per source).
  const attachment = await resolveAttachment({
    plane: deps.plane,
    minio: deps.minio,
    workspace: deps.workspace,
    projectId: project.id,
    issueId,
    planeBucket: deps.planeBucket,
    mcpBucket: deps.mcpBucket,
    minioEndpoints: deps.minioEndpoints,
    parsedId,
    rawId: deps.input.attachment_id,
  });

  // 4) Bucket whitelist — повторная защита (id-резолверы и так выставляют
  // только allowed bucket'ы, но проверка дешёвая и страхует от регрессий).
  const allowedBuckets = new Set([deps.planeBucket, deps.mcpBucket]);
  if (!allowedBuckets.has(attachment.storage.bucket)) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: `Bucket '${attachment.storage.bucket}' is not in MinIO whitelist`,
    });
  }

  // 5) statObject — контракт «вернули URL → файл точно есть».
  // mapMinioError превратит 404 в NOT_FOUND.
  const stat = await deps.minio.statObject(attachment.storage.bucket, attachment.storage.object_key);

  // 6) Presign — endpoint berётся из настроек minio-client (PUBLIC, если
  // задан; иначе INTERNAL).
  const url = await deps.minio.presignedGetObject(
    attachment.storage.bucket,
    attachment.storage.object_key,
    deps.expiresInSec,
  );

  const expiresAt = new Date(Date.now() + deps.expiresInSec * 1000).toISOString();

  return {
    download_url: url,
    method: 'GET',
    required_headers: {},
    expires_in: deps.expiresInSec,
    mime_type: stat.contentType ?? attachment.mime_type,
    size: stat.size > 0 ? stat.size : attachment.size,
    filename: attachment.filename,
    source: attachment.source,
    audit: {
      bucket: attachment.storage.bucket,
      object_key: attachment.storage.object_key,
      expires_at: expiresAt,
    },
  };
}

async function resolveAttachment(args: {
  plane: PlaneClient;
  minio: MinioClient;
  workspace: string;
  projectId: string;
  issueId: string;
  planeBucket: string;
  mcpBucket: string;
  minioEndpoints: string[];
  parsedId: ReturnType<typeof parseAttachmentId>;
  rawId: string;
}): Promise<Attachment> {
  const { parsedId } = args;
  if (parsedId.source === 'plane_issue') {
    return await resolvePlaneIssue(args, parsedId.payload);
  }
  if (parsedId.source === 'plane_comment_inline') {
    return await resolveCommentInline(args, parsedId.payload);
  }
  return await resolveMcpArtifact(args, parsedId.payload);
}

async function resolvePlaneIssue(
  args: {
    plane: PlaneClient;
    workspace: string;
    projectId: string;
    issueId: string;
    planeBucket: string;
    rawId: string;
  },
  planeAttachmentId: string,
): Promise<Attachment> {
  const list = await args.plane.listIssueAttachments(args.workspace, args.projectId, args.issueId);
  const found = list.find((p) => p.id === planeAttachmentId);
  if (found === undefined) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `Attachment ${args.rawId} not found on issue ${args.issueId}`,
    });
  }
  return {
    id: args.rawId,
    source: 'plane_issue',
    filename: found.attributes.name,
    mime_type: found.attributes.type,
    size: found.attributes.size,
    uploaded_at: found.created_at,
    ...(found.created_by !== undefined ? { uploaded_by: found.created_by } : {}),
    storage: {
      bucket: args.planeBucket,
      object_key: found.asset,
    },
  };
}

async function resolveCommentInline(
  args: {
    plane: PlaneClient;
    workspace: string;
    projectId: string;
    issueId: string;
    planeBucket: string;
    minioEndpoints: string[];
    rawId: string;
  },
  payload: string,
): Promise<Attachment> {
  const idx = payload.lastIndexOf('_');
  if (idx === -1) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: `Malformed plane_comment_inline id payload: ${args.rawId}`,
    });
  }
  const commentId = payload.slice(0, idx);
  const comments = await args.plane.listIssueComments(args.workspace, args.projectId, args.issueId);
  const comment = comments.find((c) => c.id === commentId);
  if (comment === undefined) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `Comment ${commentId} not found on issue ${args.issueId}`,
    });
  }
  const assets = extractInlineAssets(comment, {
    minioEndpoints: args.minioEndpoints,
    planeBucket: args.planeBucket,
  });
  const match = assets.find((a) => a.id === args.rawId);
  if (match === undefined) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `Inline asset ${args.rawId} not found in comment ${commentId}`,
    });
  }
  return match;
}

async function resolveMcpArtifact(
  args: {
    minio: MinioClient;
    issueId: string;
    mcpBucket: string;
    rawId: string;
  },
  payload: string,
): Promise<Attachment> {
  const objects = await args.minio.listObjectsV2(args.mcpBucket, `issues/${args.issueId}/`);
  const match = objects.find((o) => sha1(o.key).slice(0, 16) === payload);
  if (match === undefined) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `MCP artifact ${args.rawId} not found under issues/${args.issueId}/`,
    });
  }
  const parsed = parseMcaObjectKey(match.key);
  const filename = parsed.filename ?? lastSegment(match.key);
  return {
    id: args.rawId,
    source: 'mcp_artifact',
    filename,
    mime_type: inferMime(filename),
    size: match.size,
    uploaded_at: parsed.uploadedAt ?? (match.lastModified?.toISOString() ?? new Date(0).toISOString()),
    ...(parsed.uploadedBy !== undefined ? { uploaded_by: parsed.uploadedBy } : {}),
    storage: {
      bucket: args.mcpBucket,
      object_key: match.key,
    },
  };
}

function parseMcaObjectKey(
  key: string,
): { uploadedAt?: string; uploadedBy?: string; filename?: string } {
  // См. discovery.ts::parseMcaObjectKey — agent-identity содержит дефис, и
  // filename тоже. Используем тот же подход: matching `<ts>-<*-agent>-<rest>`.
  const m = /^issues\/[^/]+\/(\d+)-([a-z][a-z0-9_-]*-agent)-(.+)$/i.exec(key);
  if (m === null) return {};
  const ts = Number.parseInt(m[1]!, 10);
  const identity = m[2]!;
  const filename = m[3]!;
  if (!Number.isFinite(ts)) return { uploadedBy: identity, filename };
  return {
    uploadedAt: new Date(ts).toISOString(),
    uploadedBy: identity,
    filename,
  };
}

function lastSegment(key: string): string {
  const segs = key.split('/');
  return segs[segs.length - 1] ?? key;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  md: 'text/markdown',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

function inferMime(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
