import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { TtlCache } from '../../cache.js';
import {
  addComment,
  addMinioObject,
  addPlaneAttachment,
  fakeMinio,
  fakePlane,
  newWorld,
  seedAgentsWorkspace,
  addIssue,
} from '../test-fakes.js';
import { listAttachments } from './handler.js';

const SILENT = pino({ level: 'silent' });
const PLANE_BUCKET = 'plane-uploads';
const MCP_BUCKET = 'mcp-artifacts';
const ENDPOINTS = ['http://minio:9000'];

function setup() {
  const world = newWorld();
  const { project, states } = seedAgentsWorkspace(world);
  const issue = addIssue(world, project.id, {
    name: 'test issue',
    state: states[0]!.id,
  });
  return { world, project, issue, plane: fakePlane(world), minio: fakeMinio(world) };
}

describe('listAttachments handler', () => {
  it('returns items without storage field (internal-only)', async () => {
    const { world, project, issue, plane, minio } = setup();
    addPlaneAttachment(world, project.id, issue.id, {
      id: 'a-1',
      attributes: { name: 'x.png', size: 5, type: 'image/png' },
      asset: 'k/x.png',
      created_at: '2026-01-01T00:00:00Z',
    });
    const result = await listAttachments({
      plane,
      minio,
      cache: new TtlCache({ ttlMs: 1000 }),
      logger: SILENT,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: ENDPOINTS,
      input: {
        issue_id: issue.id,
        source: 'all',
        limit: 50,
      },
    });
    expect(result.partial).toBe(false);
    expect(result.items[0]).not.toHaveProperty('storage');
    expect(result.items[0]!.id).toBe('pi_a-1');
  });

  it('AC #4: partial=true when one source fails', async () => {
    const { world, project, issue, plane, minio } = setup();
    addPlaneAttachment(world, project.id, issue.id, {
      id: 'a-1',
      attributes: { name: 'x.png', size: 5, type: 'image/png' },
      asset: 'k/x.png',
      created_at: '2026-01-01T00:00:00Z',
    });
    addMinioObject(world, MCP_BUCKET, `issues/${issue.id}/123-developer-agent-r.md`, { size: 10 });
    world.failPlaneAttachments = true;
    const result = await listAttachments({
      plane,
      minio,
      cache: new TtlCache({ ttlMs: 1000 }),
      logger: SILENT,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: ENDPOINTS,
      input: { issue_id: issue.id, source: 'all', limit: 50 },
    });
    expect(result.partial).toBe(true);
    expect(result.items.some((a) => a.source === 'mcp_artifact')).toBe(true);
  });

  it('AC #10: comment with external <img> is filtered (SSRF)', async () => {
    const { world, project, issue, plane, minio } = setup();
    addComment(world, project.id, issue.id, {
      id: '33333333-3333-3333-3333-333333333333',
      actor: 'u',
      comment_html: `<img src="https://evil.example/x.png" />`,
      created_at: '2026-01-01T00:00:00Z',
    });
    const result = await listAttachments({
      plane,
      minio,
      cache: new TtlCache({ ttlMs: 1000 }),
      logger: SILENT,
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      planeBucket: PLANE_BUCKET,
      mcpBucket: MCP_BUCKET,
      minioEndpoints: ENDPOINTS,
      input: { issue_id: issue.id, source: 'plane_comment_inline', limit: 50 },
    });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});
