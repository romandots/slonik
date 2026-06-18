import { createHash } from 'node:crypto';
import type { AgentIdentity } from '../../identity.js';
import type { MinioClient } from '../../minio-client.js';
import type { PlaneClient } from '../../plane-client.js';
import { McpError } from '../../errors.js';
import { mcaIdFromObjectKey, type PublicAttachment } from '../../attachments/types.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveProject } from '../project-resolver.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import type { AttachFileInput } from './schema.js';

// `attach_file` has two existing phases: presign, then complete. Direct upload
// keeps that flow intact and only short-circuits both phases when content is
// provided by the MCP client.

type ToolCache = {
  clear(): void;
};

export type PresignResult = {
  kind: 'presign';
  issue_id: string;
  object_key: string;
  upload_url: string;
  method: 'PUT' | 'POST';
  expires_in: number;
  required_headers: Record<string, string>;
};

export type CompleteResult = {
  kind: 'complete';
  issue_id: string;
  object_key: string;
};

export type DirectUploadResult = {
  kind: 'direct';
  issue_id: string;
  object_key: string;
  size: number;
  attachment: PublicAttachment;
};

export interface AttachFileDeps {
  plane: PlaneClient;
  minio: MinioClient;
  cache: ToolCache;
  workspace: string;
  defaultProjectRef: string;
  identity: AgentIdentity;
  bucket: string;
  endpoint: string;
  expiresInSec: number;
  input: AttachFileInput;
}

const DIRECT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

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
    if (deps.input.size > DIRECT_UPLOAD_MAX_BYTES) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `direct upload size exceeds ${DIRECT_UPLOAD_MAX_BYTES} bytes`,
      });
    }
    const objectKey = makeObjectKey(issueId, deps.identity, deps.input.filename);
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
    await createAttachmentComment(deps, project.id, issueId, objectKey);
    deps.cache.clear();
    const uploadedAt = new Date().toISOString();

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
        uploaded_at: uploadedAt,
        uploaded_by: deps.identity,
      },
    };
  }

  if (!deps.input.complete) {
    const objectKey = deps.input.object_key ?? makeObjectKey(issueId, deps.identity, deps.input.filename);
    return {
      kind: 'presign',
      issue_id: issueId,
      object_key: objectKey,
      upload_url: objectUrl(deps.endpoint, deps.bucket, objectKey),
      method: 'PUT',
      expires_in: deps.expiresInSec,
      required_headers: {
        'Content-Type': deps.input.mime_type,
        'X-Slonk-Identity': deps.identity,
      },
    };
  }

  if (!deps.input.object_key) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: 'object_key is required when complete=true',
    });
  }

  await createAttachmentComment(deps, project.id, issueId, deps.input.object_key);
  deps.cache.clear();

  return {
    kind: 'complete',
    issue_id: issueId,
    object_key: deps.input.object_key,
  };
}

async function createAttachmentComment(
  deps: AttachFileDeps,
  projectId: string,
  issueId: string,
  objectKey: string,
): Promise<void> {
  await deps.plane.createIssueComment(deps.workspace, projectId, issueId, {
    comment_html: formatComment(
      deps.identity,
      `attached <code>${deps.input.filename}</code> (${deps.input.size} bytes) as <code>${objectKey}</code>`,
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

function objectUrl(endpoint: string, bucket: string, objectKey: string): string {
  return `${endpoint.replace(/\/$/, '')}/${bucket}/${objectKey}`;
}

function makeObjectKey(issueId: string, identity: AgentIdentity, filename: string): string {
  const ts = Date.now();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `issues/${issueId}/${ts}-${identity}-${safe}`;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}
