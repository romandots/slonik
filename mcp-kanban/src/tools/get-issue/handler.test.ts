import { describe, expect, it } from 'vitest';
import { getIssue } from './handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';
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
});
