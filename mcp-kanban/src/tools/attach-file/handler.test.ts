import { describe, expect, it } from 'vitest';
import { attachFile } from './handler.js';
import { AttachFileInput } from './schema.js';
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

  it('complete phase rejects object keys from another issue', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const minio = fakeMinio(world);

    await expect(
      attachFile({
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
          object_key: 'issues/other-issue/123-qa-agent-report.txt',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('direct upload stores content and posts a comment in one call', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { id: 'iss-1', sequence_id: 1234, name: 'Test' });
    const plane = fakePlane(world);
    const minio = fakeMinio(world);
    const content = Buffer.from('hello from chatgpt', 'utf8');

    const r = await attachFile({
      plane,
      minio,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      identity: 'developer-agent',
      bucket: 'mcp-artifacts',
      expiresInSec: 3600,
      input: {
        issue_id: 1234,
        project: 'SLONK',
        filename: 'chatgpt.txt',
        mime_type: 'text/plain',
        size: content.byteLength,
        content_base64: content.toString('base64'),
      },
    });

    expect(r.kind).toBe('direct');
    if (r.kind === 'direct') {
      expect(r.object_key).toContain('chatgpt.txt');
      expect(r.size).toBe(content.byteLength);
      expect(r.attachment).toMatchObject({
        source: 'mcp_artifact',
        filename: 'chatgpt.txt',
        mime_type: 'text/plain',
        size: content.byteLength,
        uploaded_by: 'developer-agent',
      });
      expect(world.minioObjects.get(`mcp-artifacts:${r.object_key}`)?.content?.toString('utf8')).toBe(
        'hello from chatgpt',
      );
    }
    expect([...world.comments.values()].flat()).toHaveLength(1);
  });

  it('direct upload rejects invalid base64 without storing content', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { id: 'iss-1', sequence_id: 1234, name: 'Test' });

    await expect(
      attachFile({
        plane: fakePlane(world),
        minio: fakeMinio(world),
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        identity: 'developer-agent',
        bucket: 'mcp-artifacts',
        expiresInSec: 3600,
        input: {
          issue_id: 1234,
          project: 'SLONK',
          filename: 'bad.txt',
          mime_type: 'text/plain',
          size: 1,
          content_base64: 'not base64!',
        },
      }),
    ).rejects.toThrow('content_base64 must be valid standard base64');

    expect(world.minioObjects.size).toBe(0);
    expect([...world.comments.values()].flat()).toHaveLength(0);
  });

  it('direct upload rejects size mismatch without storing content', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    addIssue(world, project.id, { id: 'iss-1', sequence_id: 1234, name: 'Test' });
    const content = Buffer.from('hello', 'utf8');

    await expect(
      attachFile({
        plane: fakePlane(world),
        minio: fakeMinio(world),
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        identity: 'developer-agent',
        bucket: 'mcp-artifacts',
        expiresInSec: 3600,
        input: {
          issue_id: 1234,
          project: 'SLONK',
          filename: 'bad.txt',
          mime_type: 'text/plain',
          size: content.byteLength + 1,
          content_base64: content.toString('base64'),
        },
      }),
    ).rejects.toThrow('content_base64 decodes to 5 bytes');

    expect(world.minioObjects.size).toBe(0);
    expect([...world.comments.values()].flat()).toHaveLength(0);
  });

  it('direct upload schema rejects payloads above encoded size limit', () => {
    const maxEncodedChars = Math.ceil((10 * 1024 * 1024) / 3) * 4;

    expect(() =>
      AttachFileInput.parse({
        issue_id: 'SLONK-1234',
        project: 'SLONK',
        filename: 'too-large.txt',
        mime_type: 'text/plain',
        size: 1,
        content_base64: `${'A'.repeat(maxEncodedChars)}A`,
      }),
    ).toThrow();
  });
});
