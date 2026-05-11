import { describe, expect, it } from 'vitest';
import { attachFile } from './handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

describe('attachFile', () => {
  it('presign phase returns an upload URL with deterministic key', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);

    const r = await attachFile({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'qa-agent',
      bucket: 'mcp-artifacts',
      endpoint: 'http://minio:9000',
      expiresInSec: 3600,
      input: {
        issue_id: issue.id,
        filename: 'report.txt',
        mime_type: 'text/plain',
        size: 1234,
      },
    });
    expect(r.kind).toBe('presign');
    if (r.kind === 'presign') {
      expect(r.upload_url).toContain('mcp-artifacts');
      expect(r.upload_url).toContain('report.txt');
      expect(r.method).toBe('PUT');
      expect(r.expires_in).toBe(3600);
    }
  });

  it('complete phase posts a comment with object link', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);

    const r = await attachFile({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'qa-agent',
      bucket: 'mcp-artifacts',
      endpoint: 'http://minio:9000',
      expiresInSec: 3600,
      input: {
        issue_id: issue.id,
        filename: 'report.txt',
        mime_type: 'text/plain',
        size: 1234,
        complete: true,
        object_key: 'issues/iss-1/123-qa-agent-report.txt',
      },
    });
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') {
      expect(r.object_key).toContain('report.txt');
    }
  });
});
