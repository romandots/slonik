import { describe, expect, it } from 'vitest';
import { extractInlineAssets } from './comment-assets.js';
import type { PlaneComment } from '../plane-client.js';

const MINIO_INTERNAL = 'http://minio:9000';
const MINIO_PUBLIC = 'http://localhost:9000';
const PLANE_BUCKET = 'plane-uploads';
const OPTS = {
  minioEndpoints: [MINIO_INTERNAL, MINIO_PUBLIC],
  planeBucket: PLANE_BUCKET,
};

function mkComment(html: string, id = '11111111-1111-1111-1111-111111111111'): PlaneComment {
  return {
    id,
    actor: 'user-abc',
    comment_html: html,
    created_at: '2026-05-17T10:00:00Z',
  };
}

describe('extractInlineAssets', () => {
  it('returns empty for empty / null html', () => {
    expect(extractInlineAssets(mkComment(''), OPTS)).toEqual([]);
    expect(extractInlineAssets({ ...mkComment('foo'), comment_html: undefined as never }, OPTS)).toEqual([]);
  });

  it('extracts a valid <img> pointing to MINIO_INTERNAL plane bucket', () => {
    const html = `<p>See: <img src="${MINIO_INTERNAL}/${PLANE_BUCKET}/issues/abc/foo.png" /></p>`;
    const out = extractInlineAssets(mkComment(html), OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('plane_comment_inline');
    expect(out[0]!.filename).toBe('foo.png');
    expect(out[0]!.mime_type).toBe('image/png');
    expect(out[0]!.storage.bucket).toBe(PLANE_BUCKET);
    expect(out[0]!.storage.object_key).toBe('issues/abc/foo.png');
    expect(out[0]!.id).toMatch(/^pci_11111111-1111-1111-1111-111111111111_[0-9a-f]{12}$/);
    expect(out[0]!.comment_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('extracts <a> hrefs pointing to MINIO_PUBLIC plane bucket', () => {
    const html = `<a href="${MINIO_PUBLIC}/${PLANE_BUCKET}/issues/abc/report.pdf">Report</a>`;
    const out = extractInlineAssets(mkComment(html), OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]!.filename).toBe('report.pdf');
    expect(out[0]!.mime_type).toBe('application/pdf');
  });

  it('filters out external URLs (SSRF protection)', () => {
    const html = `
      <img src="https://evil.example/x.png" />
      <a href="https://attacker.example/file.zip">Malicious</a>
      <img src="${MINIO_INTERNAL}/${PLANE_BUCKET}/issues/abc/good.png" />
    `;
    const out = extractInlineAssets(mkComment(html), OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]!.filename).toBe('good.png');
  });

  it('filters out URLs to a different bucket (e.g. mcp-artifacts via comment)', () => {
    const html = `<img src="${MINIO_INTERNAL}/mcp-artifacts/issues/abc/secret.png" />`;
    const out = extractInlineAssets(mkComment(html), OPTS);
    expect(out).toEqual([]);
  });

  it('filters out path-traversal attempts', () => {
    // `..` after URL parsing — `new URL` normalises, but raw `..` in pathname split
    // should still be caught. Test both .. and percent-encoded ..
    const cases = [
      `<img src="${MINIO_INTERNAL}/${PLANE_BUCKET}/../mcp-artifacts/secret.png" />`,
      `<img src="${MINIO_INTERNAL}/${PLANE_BUCKET}/issues/abc/%2e%2e/foo.png" />`,
    ];
    for (const html of cases) {
      const out = extractInlineAssets(mkComment(html), OPTS);
      // Either filtered out completely, or its object_key points to a normalised
      // path inside plane-uploads. Critical assertion: never references
      // mcp-artifacts via traversal.
      for (const a of out) {
        expect(a.storage.bucket).toBe(PLANE_BUCKET);
        expect(a.storage.object_key).not.toContain('..');
      }
    }
  });

  it('filters out non-http(s) URLs (file://, javascript:, data:)', () => {
    const html = `
      <img src="file:///etc/passwd" />
      <img src="javascript:alert(1)" />
      <img src="data:image/png;base64,AAAA" />
    `;
    expect(extractInlineAssets(mkComment(html), OPTS)).toEqual([]);
  });

  it('filters out relative URLs (no scheme/host)', () => {
    const html = `<img src="/plane-uploads/issues/abc/foo.png" />`;
    expect(extractInlineAssets(mkComment(html), OPTS)).toEqual([]);
  });

  it('deduplicates same URL referenced multiple times in one comment', () => {
    const url = `${MINIO_INTERNAL}/${PLANE_BUCKET}/issues/abc/foo.png`;
    const html = `<img src="${url}" /><a href="${url}">dup</a><img src="${url}" />`;
    const out = extractInlineAssets(mkComment(html), OPTS);
    expect(out).toHaveLength(1);
  });

  it('extracts assets from <video> and <source> tags', () => {
    const html = `
      <video src="${MINIO_INTERNAL}/${PLANE_BUCKET}/issues/abc/clip.mp4"></video>
      <video><source src="${MINIO_INTERNAL}/${PLANE_BUCKET}/issues/abc/alt.webm" /></video>
    `;
    const out = extractInlineAssets(mkComment(html), OPTS);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.filename).sort()).toEqual(['alt.webm', 'clip.mp4']);
  });

  it('uses comment_id and sha1[:12] for deterministic id', () => {
    const html = `<img src="${MINIO_INTERNAL}/${PLANE_BUCKET}/issues/abc/foo.png" />`;
    const out1 = extractInlineAssets(mkComment(html, 'c-1'), OPTS);
    const out2 = extractInlineAssets(mkComment(html, 'c-1'), OPTS);
    expect(out1[0]!.id).toBe(out2[0]!.id);

    const out3 = extractInlineAssets(mkComment(html, 'c-2'), OPTS);
    expect(out3[0]!.id).not.toBe(out1[0]!.id);
  });

  it('ignores assets when no minio endpoints are configured', () => {
    const html = `<img src="${MINIO_INTERNAL}/${PLANE_BUCKET}/issues/abc/foo.png" />`;
    const out = extractInlineAssets(mkComment(html), { minioEndpoints: [], planeBucket: PLANE_BUCKET });
    expect(out).toEqual([]);
  });
});
