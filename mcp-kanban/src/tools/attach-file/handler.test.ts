import { describe, expect, it } from 'vitest';
import { attachFile } from './handler.js';
import { TtlCache } from '../../cache.js';
import {
  addIssue,
  addMinioObject,
  fakeMinio,
  fakePlane,
  newWorld,
  seedAgentsWorkspace,
} from '../test-fakes.js';

describe('attachFile', () => {
  it('presign phase returns an upload URL with deterministic key', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const minio = fakeMinio(world);

    const r = await attachFile({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      identity: 'qa-agent',
      bucket: 'mcp-artifacts',
      minio,
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
      expect(r.upload_url).toMatch(/^https:\/\/fake-minio\.local\/mcp-artifacts\//);
      expect(r.upload_url).toContain('X-Amz-Signature=fake-put-signature');
      expect(r.upload_url).toContain('report.txt');
      expect(r.method).toBe('PUT');
      expect(r.required_headers).toEqual({});
      expect(r.expires_in).toBe(3600);
    }
  });

  it('complete phase posts a comment with object link', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const minio = fakeMinio(world);
    const objectKey = 'issues/iss-1/123-qa-agent-report.txt';
    addMinioObject(world, 'mcp-artifacts', objectKey, {
      size: 1234,
      contentType: 'text/plain',
    });

    const r = await attachFile({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      identity: 'qa-agent',
      bucket: 'mcp-artifacts',
      minio,
      expiresInSec: 3600,
      input: {
        issue_id: issue.id,
        filename: 'report.txt',
        mime_type: 'text/plain',
        size: 1234,
        complete: true,
        object_key: objectKey,
      },
    });
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') {
      expect(r.object_key).toContain('report.txt');
    }
    const comments = world.comments.get(`${project.id}:${issue.id}`) ?? [];
    expect(comments[0]!.comment_html).toContain('https://fake-minio.local/mcp-artifacts/');
    expect(comments[0]!.comment_html).toContain('X-Amz-Signature=fake-signature');
  });
});
