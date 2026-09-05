import type { PlaneClient } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import type { AssetUploader } from '../../plane-asset-upload.js';
import { McpError } from '../../errors.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveProject } from '../project-resolver.js';
import { resolveIssueId } from '../update-issue/handler.js';
import type { EmbedImageInput } from './schema.js';

// `embed_image` (SLONK-32) — встраивает растровую картинку в задачу как
// нативный Plane workspace-asset, чтобы человек видел её в Plane UI (а не
// текстовую ссылку). Протокол подтверждён по Plane v1.3.0
// (GenericAssetEndpoint, token-API):
//   1) POST  /workspaces/<slug>/assets/  {name,type,size,project_id}
//        → { upload_data: presigned S3 POST, asset_id, asset_url }
//   2) S3 presigned POST (multipart) тела файла в bucket
//   3) PATCH /workspaces/<slug>/assets/<asset_id>/  {is_uploaded:true}
//   4) вставка inline-узла редактора <image-component src="<asset_id>"> в
//      description_html (read-modify-write, без затирания) или comment_html.

// Только растровые форматы. `image/svg+xml` запрещён осознанно: SVG может
// нести скрипт → stored-XSS в Plane UI. Plane сам по себе svg разрешает —
// поэтому ограничиваем на нашей стороне.
const RASTER_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

// asset_id из Plane обязан быть UUID, прежде чем мы вставим его в src=...
// (defense-in-depth: не доверяем форме ответа вслепую при построении HTML).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EmbedImageResult {
  issue_id: string;
  target: 'description' | 'comment';
  asset_id: string;
  asset_url: string;
  filename: string;
  mime_type: string;
  size: number;
  /** Присутствует, если target=comment. */
  comment_id?: string;
}

export interface EmbedImageDeps {
  plane: PlaneClient;
  uploader: AssetUploader;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  identity: AgentIdentity;
  /** Лимит размера decoded-картинки (MCP_ATTACH_MAX_BYTES). */
  maxBytes: number;
  input: EmbedImageInput;
}

export async function embedImage(deps: EmbedImageDeps): Promise<EmbedImageResult> {
  const { input } = deps;

  // 1) MIME raster-only allowlist (svg запрещён).
  const mime = input.mime_type.toLowerCase();
  if (!RASTER_IMAGE_MIME.has(mime)) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: `embed_image accepts only raster images (png, jpeg, gif, webp); got '${input.mime_type}'`,
    });
  }

  // 2) Размерный лимит (единый source-of-truth из config) + целостность base64.
  if (input.size > deps.maxBytes) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: `image size exceeds the configured limit (${deps.maxBytes} bytes)`,
    });
  }
  const content = decodeBase64(input.content_base64);
  if (content.byteLength !== input.size) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: `content_base64 decodes to ${content.byteLength} bytes`,
    });
  }

  // Резолвим проект и issue (как attach_file).
  const parsed = parseIssueRef(String(input.issue_id));
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(input.project !== undefined
      ? { projectRef: input.project }
      : parsed.kind === 'sequence' && parsed.identifier !== undefined
        ? { projectRef: parsed.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });
  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsed);

  // 3) Создаём asset → presigned POST.
  const asset = await deps.plane.createGenericAsset(deps.workspace, {
    name: input.filename,
    type: mime,
    size: content.byteLength,
    project_id: project.id,
  });
  if (!UUID_RE.test(asset.asset_id)) {
    throw new McpError({
      code: 'PLANE_UNAVAILABLE',
      message: 'Plane returned a non-UUID asset id; refusing to build inline node',
    });
  }

  // 4) Заливаем байты в storage через presigned POST.
  await deps.uploader.upload(asset.upload_data, content, mime, input.filename);

  // 5) Помечаем загруженным.
  await deps.plane.markGenericAssetUploaded(deps.workspace, asset.asset_id);

  // 6) Строим inline-узел. asset_id — провалидированный UUID; caption —
  // пользовательский, экранируем. НЕ прогоняем через sanitizeHtml: он вырезал
  // бы <image-component> (его нет в whitelist), а src здесь безопасен.
  const node = `<image-component src="${asset.asset_id}"></image-component>`;
  const caption = input.caption !== undefined ? `<p>${escapeHtml(input.caption)}</p>` : '';
  const html = node + caption;

  let commentId: string | undefined;
  if (input.target === 'description') {
    // Read-modify-write: дописываем к существующему описанию, не затирая.
    const issue = await deps.plane.getIssue(deps.workspace, project.id, issueId);
    if (issue === undefined) {
      throw new McpError({ code: 'NOT_FOUND', message: `issue ${issueId} not found` });
    }
    const existing = issue.description_html ?? '';
    await deps.plane.updateIssue(deps.workspace, project.id, issueId, {
      description_html: existing + html,
    });
  } else {
    const comment = await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
      comment_html: `<p><strong>[${deps.identity}]</strong></p>${html}`,
    });
    commentId = comment.id;
  }
  deps.cache.clear();

  return {
    issue_id: issueId,
    target: input.target,
    asset_id: asset.asset_id,
    asset_url: asset.asset_url,
    filename: input.filename,
    mime_type: mime,
    size: content.byteLength,
    ...(commentId !== undefined ? { comment_id: commentId } : {}),
  };
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new McpError({ code: 'INVALID_INPUT', message: 'content_base64 must be valid standard base64' });
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64') !== normalized) {
    throw new McpError({ code: 'INVALID_INPUT', message: 'content_base64 must be canonical standard base64' });
  }
  return decoded;
}

/** HTML-escape пользовательских значений (caption), вставляемых в editor-HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
