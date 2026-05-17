import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { getIssue } from './handler.js';
import { TtlCache } from '../../cache.js';
import {
  addIssue,
  addMinioObject,
  addPlaneAttachment,
  fakeMinio,
  fakePlane,
  newWorld,
  seedAgentsWorkspace,
} from '../test-fakes.js';
import { parseIssueRef } from './schema.js';
import { MetaBlockMarker } from '../../meta-block.js';

describe('parseIssueRef', () => {
  it('detects SLONK-123 as sequence', () => {
    const r = parseIssueRef('SLONK-123');
    expect(r.kind).toBe('sequence');
    expect(r.identifier).toBe('SLONK');
    expect(r.sequence).toBe(123);
  });
  it('treats uuid-shaped strings as uuid', () => {
    const r = parseIssueRef('11111111-2222-3333-4444-555555555555');
    expect(r.kind).toBe('uuid');
  });
});

describe('getIssue', () => {
  it('returns issue + parsed meta block', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const body = [
      'Body paragraph.',
      '',
      '---',
      MetaBlockMarker,
      'repos:',
      '  - url: https://github.com/acme/x',
      '    branch: feature/SLONK-1',
      '    commits: ["abc1234"]',
      '',
    ].join('\n');
    addIssue(world, project.id, { name: 'A', state: 'st-To Do', description: body });
    const plane = fakePlane(world);

    const r = await getIssue({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: 'SLONK-1',
    });

    expect(r.name).toBe('A');
    expect(r.description_body).toContain('Body paragraph');
    expect(r.meta.repos).toHaveLength(1);
    expect(r.meta.repos[0]?.branch).toBe('feature/SLONK-1');
    expect(r.meta_corrupt).toBe(false);
  });

  it('flags corrupt meta block without losing description body', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const body = `Body\n---\n${MetaBlockMarker}\nrepos: [garbage`;
    addIssue(world, project.id, { name: 'B', state: 'st-To Do', description: body });
    const plane = fakePlane(world);
    const r = await getIssue({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: 'SLONK-1',
    });
    expect(r.meta_corrupt).toBe(true);
    expect(r.description_body).toContain('Body');
  });

  it('throws NOT_FOUND when issue is missing', async () => {
    const world = newWorld();
    seedAgentsWorkspace(world);
    const plane = fakePlane(world);
    await expect(
      getIssue({
        plane,
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        allowedProjects: ['SLONK'],
        issueRef: 'SLONK-42',
      }),
    ).rejects.toThrowError(/not found/);
  });

  // ---- SLONK-14: attachments_count + attachments_preview ----
  it('AC #9: returns attachments_count and attachments_preview (top-3 DESC)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addPlaneAttachment(world, project.id, issue.id, {
      id: 'a1',
      attributes: { name: 'older.png', size: 1, type: 'image/png' },
      asset: 'k/older.png',
      created_at: '2026-01-01T00:00:00Z',
    });
    addPlaneAttachment(world, project.id, issue.id, {
      id: 'a2',
      attributes: { name: 'newer.png', size: 2, type: 'image/png' },
      asset: 'k/newer.png',
      created_at: '2026-02-01T00:00:00Z',
    });
    const plane = fakePlane(world);
    const minio = fakeMinio(world);
    const r = await getIssue({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: 'SLONK-1',
      minio,
      planeBucket: 'plane-uploads',
      mcpBucket: 'mcp-artifacts',
      minioEndpoints: ['http://minio:9000'],
      logger: pino({ level: 'silent' }),
    });
    expect(r.attachments_count).toBe(2);
    expect(r.attachments_preview).toHaveLength(2);
    expect(r.attachments_preview[0]!.filename).toBe('newer.png');
    expect(r.attachments_preview[0]).not.toHaveProperty('storage');
  });

  it('AC #9 backwards-compat: returns 0/[] when minio deps are absent', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const r = await getIssue({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: 'SLONK-1',
    });
    expect(r.attachments_count).toBe(0);
    expect(r.attachments_preview).toEqual([]);
  });

  it('does not throw when attachments discovery partially fails', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    addMinioObject(world, 'mcp-artifacts', `issues/${issue.id}/100-developer-agent-x.txt`, {
      size: 5,
    });
    world.failPlaneAttachments = true;
    const plane = fakePlane(world);
    const minio = fakeMinio(world);
    const r = await getIssue({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      issueRef: 'SLONK-1',
      minio,
      planeBucket: 'plane-uploads',
      mcpBucket: 'mcp-artifacts',
      minioEndpoints: ['http://minio:9000'],
      logger: pino({ level: 'silent' }),
    });
    // Partial → empty preview, but get_issue itself succeeds
    expect(r.attachments_count).toBe(0);
    expect(r.attachments_preview).toEqual([]);
    expect(r.name).toBe('A');
  });
});
