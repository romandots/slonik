import { beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  addComment,
  addMinioObject,
  addPlaneAttachment,
  fakeMinio,
  fakePlane,
  newWorld,
  seedAgentsWorkspace,
  type FakeWorld,
} from '../tools/test-fakes.js';
import { discoverAttachments } from './discovery.js';

const SILENT = pino({ level: 'silent' });
const PLANE_BUCKET = 'plane-uploads';
const MCP_BUCKET = 'mcp-artifacts';
const MINIO_ENDPOINTS = ['http://minio:9000', 'http://localhost:9000'];

interface Ctx {
  world: FakeWorld;
  plane: ReturnType<typeof fakePlane>;
  minio: ReturnType<typeof fakeMinio>;
  projectId: string;
  issueId: string;
}

function setupAll(): Ctx {
  const world = newWorld();
  const { project } = seedAgentsWorkspace(world);
  const issueId = 'iss-1';
  // Plane UI attachment
  addPlaneAttachment(world, project.id, issueId, {
    id: 'plane-att-1',
    attributes: { name: 'screenshot.png', size: 1024, type: 'image/png' },
    asset: 'uploads/screenshot.png',
    created_at: '2026-05-01T12:00:00Z',
    created_by: 'user-x',
  });
  // Inline asset in comment
  const commentId = '22222222-2222-2222-2222-222222222222';
  const inlineUrl = `http://minio:9000/${PLANE_BUCKET}/issues/${issueId}/inline.jpg`;
  addComment(world, project.id, issueId, {
    id: commentId,
    actor: 'user-y',
    comment_html: `<p>Look <img src="${inlineUrl}" /></p>`,
    created_at: '2026-05-05T12:00:00Z',
  });
  addMinioObject(world, PLANE_BUCKET, `issues/${issueId}/inline.jpg`, {
    size: 2048,
    contentType: 'image/jpeg',
  });
  // MCP artifact — timestamp parses out of object_key (May 10 2026).
  const mcaTs = Date.UTC(2026, 4, 10, 12, 0, 0);
  addMinioObject(world, MCP_BUCKET, `issues/${issueId}/${mcaTs}-developer-agent-report.md`, {
    size: 4096,
    lastModified: new Date('2026-05-10T12:00:00Z'),
  });
  return { world, plane: fakePlane(world), minio: fakeMinio(world), projectId: project.id, issueId };
}

describe('discoverAttachments', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupAll();
  });

  it('merges all three sources and sorts DESC by uploaded_at', async () => {
    const out = await discoverAttachments({
      plane: ctx.plane,
      minio: ctx.minio,
      logger: SILENT,
      workspace: 'agents',
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: MINIO_ENDPOINTS,
      filters: { limit: 50 },
    });
    expect(out.partial).toBe(false);
    expect(out.failed_sources).toEqual([]);
    expect(out.total).toBe(3);
    expect(out.items).toHaveLength(3);
    // Sort DESC: mca (May 10) > pci (May 5) > pi (May 1)
    expect(out.items[0]!.source).toBe('mcp_artifact');
    expect(out.items[1]!.source).toBe('plane_comment_inline');
    expect(out.items[2]!.source).toBe('plane_issue');
  });

  it('AC #2: source=mcp_artifact filters to only that bucket', async () => {
    const out = await discoverAttachments({
      plane: ctx.plane,
      minio: ctx.minio,
      logger: SILENT,
      workspace: 'agents',
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: MINIO_ENDPOINTS,
      filters: { source: 'mcp_artifact' },
    });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.source).toBe('mcp_artifact');
    expect(out.items[0]!.filename).toBe('report.md');
  });

  it('AC #3: comment_id filter narrows to that comment', async () => {
    const out = await discoverAttachments({
      plane: ctx.plane,
      minio: ctx.minio,
      logger: SILENT,
      workspace: 'agents',
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: MINIO_ENDPOINTS,
      filters: { comment_id: '22222222-2222-2222-2222-222222222222' },
    });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.source).toBe('plane_comment_inline');
  });

  it('AC #4: partial=true when plane source fails, others continue', async () => {
    ctx.world.failPlaneAttachments = true;
    const out = await discoverAttachments({
      plane: ctx.plane,
      minio: ctx.minio,
      logger: SILENT,
      workspace: 'agents',
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: MINIO_ENDPOINTS,
    });
    expect(out.partial).toBe(true);
    expect(out.failed_sources).toEqual(['plane_issue']);
    expect(out.items).toHaveLength(2);
    expect(out.items.some((a) => a.source === 'mcp_artifact')).toBe(true);
    expect(out.items.some((a) => a.source === 'plane_comment_inline')).toBe(true);
  });

  it('partial=true when MinIO list fails', async () => {
    ctx.world.failMinioList = true;
    const out = await discoverAttachments({
      plane: ctx.plane,
      minio: ctx.minio,
      logger: SILENT,
      workspace: 'agents',
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: MINIO_ENDPOINTS,
    });
    expect(out.partial).toBe(true);
    expect(out.failed_sources).toContain('mcp_artifact');
    expect(out.items.some((a) => a.source === 'plane_issue')).toBe(true);
  });

  it('respects limit and emits next_cursor', async () => {
    const out = await discoverAttachments({
      plane: ctx.plane,
      minio: ctx.minio,
      logger: SILENT,
      workspace: 'agents',
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: MINIO_ENDPOINTS,
      filters: { limit: 2 },
    });
    expect(out.items).toHaveLength(2);
    expect(out.total).toBe(3);
    expect(out.next_cursor).toBeDefined();
  });

  it('inline asset size is populated via statObject', async () => {
    const out = await discoverAttachments({
      plane: ctx.plane,
      minio: ctx.minio,
      logger: SILENT,
      workspace: 'agents',
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: MINIO_ENDPOINTS,
      filters: { source: 'plane_comment_inline' },
    });
    expect(out.items[0]!.size).toBe(2048);
    expect(out.items[0]!.mime_type).toBe('image/jpeg');
  });
});
