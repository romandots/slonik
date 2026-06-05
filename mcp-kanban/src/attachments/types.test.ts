import { describe, expect, it } from 'vitest';
import { mcaIdFromObjectKey, parseAttachmentId, pciIdFromAsset, toPublic } from './types.js';
import type { Attachment } from './types.js';
import { McpError } from '../errors.js';
import { createHash } from 'node:crypto';

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

describe('parseAttachmentId', () => {
  it('parses plane_issue ids', () => {
    expect(parseAttachmentId('pi_abc-123')).toEqual({ source: 'plane_issue', payload: 'abc-123' });
  });

  it('rejects empty plane_issue payload', () => {
    expect(() => parseAttachmentId('pi_')).toThrow(McpError);
  });

  it('parses plane_comment_inline ids', () => {
    const id = `pci_11111111-1111-1111-1111-111111111111_${'a'.repeat(12)}`;
    expect(parseAttachmentId(id)).toEqual({
      source: 'plane_comment_inline',
      payload: `11111111-1111-1111-1111-111111111111_${'a'.repeat(12)}`,
    });
  });

  it('rejects malformed plane_comment_inline ids', () => {
    expect(() => parseAttachmentId('pci_no-underscore-hash')).toThrow(McpError);
    expect(() => parseAttachmentId('pci_uuid_too-short')).toThrow(McpError);
  });

  it('parses mcp_artifact ids', () => {
    const id = `mca_${'0'.repeat(16)}`;
    expect(parseAttachmentId(id)).toEqual({ source: 'mcp_artifact', payload: '0'.repeat(16) });
  });

  it('rejects malformed mcp_artifact ids', () => {
    expect(() => parseAttachmentId('mca_short')).toThrow(McpError);
    expect(() => parseAttachmentId('mca_' + 'z'.repeat(16))).toThrow(McpError);
  });

  it('rejects unknown prefixes', () => {
    expect(() => parseAttachmentId('foo_bar')).toThrow(McpError);
    expect(() => parseAttachmentId('')).toThrow(McpError);
  });
});

describe('id generators', () => {
  it('mcaIdFromObjectKey is deterministic and 16hex', () => {
    const id = mcaIdFromObjectKey('issues/abc/123-developer-agent-foo.png', sha1);
    expect(id).toMatch(/^mca_[0-9a-f]{16}$/);
    expect(mcaIdFromObjectKey('issues/abc/123-developer-agent-foo.png', sha1)).toBe(id);
  });

  it('pciIdFromAsset embeds comment_id + sha1(url)[:12]', () => {
    const id = pciIdFromAsset('c-1', 'http://minio/foo', sha1);
    expect(id).toMatch(/^pci_c-1_[0-9a-f]{12}$/);
  });
});

describe('toPublic', () => {
  it('strips storage field', () => {
    const a: Attachment = {
      id: 'pi_1',
      source: 'plane_issue',
      filename: 'foo.png',
      mime_type: 'image/png',
      size: 10,
      uploaded_at: '2026-01-01T00:00:00Z',
      storage: { bucket: 'b', object_key: 'k' },
    };
    const pub = toPublic(a);
    expect(pub).not.toHaveProperty('storage');
    expect(pub.id).toBe('pi_1');
  });
});
