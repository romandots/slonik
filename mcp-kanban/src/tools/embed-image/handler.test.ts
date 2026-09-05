import { describe, expect, it } from 'vitest';
import { embedImage } from './handler.js';
import { TtlCache } from '../../cache.js';
import {
  addIssue,
  fakeAssetUploader,
  fakePlane,
  newWorld,
  seedAgentsWorkspace,
} from '../test-fakes.js';

const PNG = Buffer.from('\x89PNG\r\n\x1a\n fake png bytes', 'binary');

function baseDeps(world: ReturnType<typeof newWorld>, projectId: string) {
  return {
    plane: fakePlane(world),
    uploader: fakeAssetUploader(world),
    cache: new TtlCache(),
    workspace: 'agents',
    defaultProjectRef: 'SLONK',
    identity: 'developer-agent' as const,
    maxBytes: 10 * 1024 * 1024,
    projectId,
  };
}

describe('embedImage', () => {
  it('uploads a raster image and appends an <image-component> to the description (read-modify-write)', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, {
      id: 'iss-1',
      sequence_id: 7,
      name: 'X',
      description_html: '<p>existing</p>',
    });
    const d = baseDeps(world, project.id);

    const r = await embedImage({
      plane: d.plane,
      uploader: d.uploader,
      cache: d.cache,
      workspace: d.workspace,
      defaultProjectRef: d.defaultProjectRef,
      identity: d.identity,
      maxBytes: d.maxBytes,
      input: {
        issue_id: issue.id,
        target: 'description',
        filename: 'diagram.png',
        mime_type: 'image/png',
        size: PNG.byteLength,
        content_base64: PNG.toString('base64'),
        caption: 'a <b>diagram</b>',
      },
    });

    expect(r.target).toBe('description');
    expect(r.asset_id).toMatch(/^[0-9a-f-]{36}$/);
    // asset помечен загруженным
    expect(world.genericAssets.get(r.asset_id)?.is_uploaded).toBe(true);
    // описание дополнено, существующее НЕ затёрто, узел вставлен
    const updated = world.issues.get(project.id)!.find((i) => i.id === issue.id)!;
    expect(updated.description_html).toContain('existing');
    expect(updated.description_html).toContain(`<image-component src="${r.asset_id}">`);
    // caption экранирован
    expect(updated.description_html).toContain('a &lt;b&gt;diagram&lt;/b&gt;');
    expect(updated.description_html).not.toContain('<b>diagram</b>');
  });

  it('embeds into a new comment when target=comment', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { id: 'iss-2', sequence_id: 8, name: 'Y' });
    const d = baseDeps(world, project.id);

    const r = await embedImage({
      plane: d.plane,
      uploader: d.uploader,
      cache: d.cache,
      workspace: d.workspace,
      defaultProjectRef: d.defaultProjectRef,
      identity: d.identity,
      maxBytes: d.maxBytes,
      input: {
        issue_id: issue.id,
        target: 'comment',
        filename: 'shot.webp',
        mime_type: 'image/webp',
        size: PNG.byteLength,
        content_base64: PNG.toString('base64'),
      },
    });

    expect(r.target).toBe('comment');
    expect(r.comment_id).toBeDefined();
    const comments = world.comments.get(`${project.id}:${issue.id}`) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]!.comment_html).toContain(`<image-component src="${r.asset_id}">`);
    expect(comments[0]!.comment_html).toContain('[developer-agent]');
  });

  it('rejects SVG (stored-XSS) and other non-raster types without creating an asset', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { id: 'iss-3', sequence_id: 9, name: 'Z' });
    const d = baseDeps(world, project.id);

    await expect(
      embedImage({
        plane: d.plane,
        uploader: d.uploader,
        cache: d.cache,
        workspace: d.workspace,
        defaultProjectRef: d.defaultProjectRef,
        identity: d.identity,
        maxBytes: d.maxBytes,
        input: {
          issue_id: issue.id,
          target: 'description',
          filename: 'x.svg',
          mime_type: 'image/svg+xml',
          size: PNG.byteLength,
          content_base64: PNG.toString('base64'),
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(world.genericAssets.size).toBe(0);
  });

  it('rejects an image above the configured size limit', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { id: 'iss-4', sequence_id: 10, name: 'Z' });
    const d = baseDeps(world, project.id);

    await expect(
      embedImage({
        plane: d.plane,
        uploader: d.uploader,
        cache: d.cache,
        workspace: d.workspace,
        defaultProjectRef: d.defaultProjectRef,
        identity: d.identity,
        maxBytes: 4, // меньше размера файла
        input: {
          issue_id: issue.id,
          target: 'description',
          filename: 'big.png',
          mime_type: 'image/png',
          size: PNG.byteLength,
          content_base64: PNG.toString('base64'),
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(world.genericAssets.size).toBe(0);
  });

  it('surfaces a storage failure from the presigned upload and does not mark the asset uploaded', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { id: 'iss-5', sequence_id: 11, name: 'Z' });

    await expect(
      embedImage({
        plane: fakePlane(world),
        uploader: fakeAssetUploader(world, { fail: true }),
        cache: new TtlCache(),
        workspace: 'agents',
        defaultProjectRef: 'SLONK',
        identity: 'developer-agent',
        maxBytes: 10 * 1024 * 1024,
        input: {
          issue_id: issue.id,
          target: 'description',
          filename: 'd.png',
          mime_type: 'image/png',
          size: PNG.byteLength,
          content_base64: PNG.toString('base64'),
        },
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

    // asset создан, но НЕ помечен загруженным (upload упал до PATCH).
    const asset = [...world.genericAssets.values()][0];
    expect(asset?.is_uploaded).toBe(false);
  });
});
