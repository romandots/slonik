import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { attachFile } from './handler.js';
import { AttachFileInput } from './schema.js';
import { TtlCache } from '../../cache.js';
import { McpError } from '../../errors.js';
import { mcaIdFromObjectKey } from '../../attachments/types.js';
import {
  addIssue,
  addMinioObject,
  fakeMinio,
  fakePlane,
  newWorld,
  seedAgentsWorkspace,
} from '../test-fakes.js';

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

describe('attachFile', () => {
  it('presign phase returns a real signed PUT URL with a deterministic key', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });

    const r = await attachFile({
      plane: fakePlane(world),
      minio: fakeMinio(world),
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      identity: 'qa-agent',
      bucket: 'mcp-artifacts',
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
      // Реальный presign — подписанный URL, а не голая конкатенация.
      expect(r.upload_url).toContain('X-Amz-Signature');
      expect(r.upload_url).toContain('X-Amz-Method=PUT');
      expect(r.method).toBe('PUT');
      expect(r.expires_in).toBe(3600);
      expect(r.object_key).toMatch(new RegExp(`^issues/${issue.id}/\\d+-qa-agent-report\\.txt$`));
    }
  });

  it('complete phase verifies the upload, registers an mca_ artifact, and posts a comment', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const objectKey = `issues/${issue.id}/123-qa-agent-report.txt`;
    // Симулируем успешный PUT агента: объект уже в bucket'е.
    addMinioObject(world, 'mcp-artifacts', objectKey, { size: 1234, contentType: 'text/plain' });

    const r = await attachFile({
      plane: fakePlane(world),
      minio: fakeMinio(world),
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      identity: 'qa-agent',
      bucket: 'mcp-artifacts',
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
      expect(r.attachment_id).toBe(mcaIdFromObjectKey(objectKey, sha1));
      expect(r.attachment_id).toMatch(/^mca_[0-9a-f]{16}$/);
      expect(r.size).toBe(1234);
      expect(r.download_url).toContain('X-Amz-Signature');
    }

    // Комментарий-аннотация запостен и несёт стабильный artifact-id, но НЕ
    // presigned URL (чтобы подпись не оседала в истории задачи).
    const comments = world.comments.get(`${project.id}:${issue.id}`) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]!.comment_html).toContain('report.txt');
    expect(comments[0]!.comment_html).toContain(mcaIdFromObjectKey(objectKey, sha1));
    expect(comments[0]!.comment_html).not.toContain('X-Amz-Signature');
  });

  it('complete phase appends an optional note to the annotation comment', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const objectKey = `issues/${issue.id}/123-qa-agent-log.txt`;
    addMinioObject(world, 'mcp-artifacts', objectKey, { size: 10, contentType: 'text/plain' });

    await attachFile({
      plane: fakePlane(world),
      minio: fakeMinio(world),
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      identity: 'qa-agent',
      bucket: 'mcp-artifacts',
      expiresInSec: 3600,
      input: {
        issue_id: issue.id,
        filename: 'log.txt',
        mime_type: 'text/plain',
        size: 10,
        complete: true,
        object_key: objectKey,
        note: 'test run output',
      },
    });

    const comments = world.comments.get(`${project.id}:${issue.id}`) ?? [];
    expect(comments[0]!.comment_html).toContain('test run output');
  });

  it('complete phase fails NOT_FOUND when the object was never uploaded', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });

    await expect(
      attachFile({
        plane: fakePlane(world),
        minio: fakeMinio(world),
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        identity: 'qa-agent',
        bucket: 'mcp-artifacts',
        expiresInSec: 3600,
        input: {
          issue_id: issue.id,
          filename: 'report.txt',
          mime_type: 'text/plain',
          size: 1234,
          complete: true,
          object_key: `issues/${issue.id}/123-qa-agent-report.txt`,
        },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Комментарий НЕ постится, если файла нет.
    expect(world.comments.get(`${project.id}:${issue.id}`) ?? []).toHaveLength(0);
  });

  it('complete phase rejects an object_key outside the issue prefix', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });

    await expect(
      attachFile({
        plane: fakePlane(world),
        minio: fakeMinio(world),
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        identity: 'qa-agent',
        bucket: 'mcp-artifacts',
        expiresInSec: 3600,
        input: {
          issue_id: issue.id,
          filename: 'report.txt',
          mime_type: 'text/plain',
          size: 1234,
          complete: true,
          object_key: 'issues/other-issue/evil.txt',
        },
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it('complete phase requires object_key', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });

    await expect(
      attachFile({
        plane: fakePlane(world),
        minio: fakeMinio(world),
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        identity: 'qa-agent',
        bucket: 'mcp-artifacts',
        expiresInSec: 3600,
        input: {
          issue_id: issue.id,
          filename: 'report.txt',
          mime_type: 'text/plain',
          size: 1234,
          complete: true,
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
      allowedProjects: ['SLONK'],
      identity: 'developer-agent',
      bucket: 'mcp-artifacts',
      endpoint: 'http://minio:9000',
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
        allowedProjects: ['SLONK'],
        identity: 'developer-agent',
        bucket: 'mcp-artifacts',
        endpoint: 'http://minio:9000',
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
        allowedProjects: ['SLONK'],
        identity: 'developer-agent',
        bucket: 'mcp-artifacts',
        endpoint: 'http://minio:9000',
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
