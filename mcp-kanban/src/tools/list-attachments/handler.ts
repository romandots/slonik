import type { PlaneClient } from '../../plane-client.js';
import type { MinioClient } from '../../minio-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import type { Logger } from '../../logger.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { discoverAttachments, type DiscoveryResult } from '../../attachments/discovery.js';
import { toPublic, type PublicAttachment } from '../../attachments/types.js';
import type { ListAttachmentsInput } from './schema.js';

export interface ListAttachmentsResult {
  items: PublicAttachment[];
  next_cursor?: string;
  total: number;
  partial: boolean;
}

export async function listAttachments(deps: {
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
  input: ListAttachmentsInput;
}): Promise<ListAttachmentsResult> {
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

  const cacheKey = `list_attachments:${inputHash({
    ws: deps.workspace,
    pr: project.id,
    issue: issueId,
    src: deps.input.source,
    cm: deps.input.comment_id ?? null,
    since: deps.input.since ?? null,
    limit: deps.input.limit,
    cursor: deps.input.cursor ?? null,
  })}`;

  const result = (await deps.cache.memoize(cacheKey, async () =>
    await discoverAttachments({
      plane: deps.plane,
      minio: deps.minio,
      logger: deps.logger,
      workspace: deps.workspace,
      projectId: project.id,
      issueId,
      planeBucket: deps.planeBucket,
      mcpBucket: deps.mcpBucket,
      minioEndpoints: deps.minioEndpoints,
      filters: {
        ...(deps.input.source !== undefined ? { source: deps.input.source } : {}),
        ...(deps.input.comment_id !== undefined ? { comment_id: deps.input.comment_id } : {}),
        ...(deps.input.since !== undefined ? { since: deps.input.since } : {}),
        ...(deps.input.limit !== undefined ? { limit: deps.input.limit } : {}),
        ...(deps.input.cursor !== undefined ? { cursor: deps.input.cursor } : {}),
      },
    }),
  )) as DiscoveryResult;

  return {
    items: result.items.map(toPublic),
    ...(result.next_cursor !== undefined ? { next_cursor: result.next_cursor } : {}),
    total: result.total,
    partial: result.partial,
  };
}
