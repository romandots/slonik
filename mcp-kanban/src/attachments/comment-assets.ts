import { createHash } from 'node:crypto';
import { parse as parseHtml } from 'node-html-parser';
import type { PlaneComment } from '../plane-client.js';
import type { Attachment } from './types.js';
import { pciIdFromAsset } from './types.js';

// Парсер inline-assets из `comment_html` (SLONK-14).
//
// Strict SSRF filter: принимаем asset URL только если он указывает на
// одну из known MinIO host:port (public+internal), схема та же, и первый
// сегмент path равен MINIO_BUCKET_PLANE. Любой внешний URL, path-traversal
// или относительный URL — игнорируем (см. design §7.3).
//
// Дополнительно `comment_id` сериализуется в id вложения вместе с
// sha1(url)[:12] — это нужно для stateless reverse-resolution в
// `read_attachment`.

export interface CommentAssetsOptions {
  /**
   * Список known MinIO endpoints (`MINIO_PUBLIC_ENDPOINT` +
   * `MINIO_INTERNAL_ENDPOINT`). Сравниваем по `protocol + host + port`
   * — это и есть «origin» URL'а.
   */
  minioEndpoints: string[];
  /** Имя bucket'а Plane (`MINIO_BUCKET_PLANE`). */
  planeBucket: string;
  /**
   * Known Plane UI/API origins для absolute asset-API URL'ов.
   * Editor-native `<image-component src="<asset-uuid>">` не использует
   * внешний origin и резолвится через Plane API по UUID.
   */
  planeAssetEndpoints?: string[];
}

export type InlineAssetRef =
  | {
      kind: 'minio';
      ref: string;
      filename: string;
      mime_type: string;
      bucket: string;
      object_key: string;
    }
  | {
      kind: 'plane_asset';
      ref: string;
      asset_id: string;
    };

/**
 * Чистая функция: ничего не вызывает по сети, только парсит HTML +
 * фильтрует URL'ы. Это позволяет unit-тестам гонять SSRF-fixture'ы без
 * мока MinIO/Plane.
 *
 * `size` для inline-asset'ов парсер не знает — выставляет 0; реальный
 * размер заполнит discovery через `statObject`. Это компромисс между
 * чистотой функции и тем, что без statObject мы не знаем `size` —
 * design §5.4 фиксирует, что statObject делает discovery, не парсер.
 */
export function extractInlineAssets(
  comment: PlaneComment,
  options: CommentAssetsOptions,
): Attachment[] {
  return extractInlineAssetRefs(comment.comment_html ?? '', options)
    .filter((ref): ref is Extract<InlineAssetRef, { kind: 'minio' }> => ref.kind === 'minio')
    .map((ref) => ({
      id: pciIdFromAsset(comment.id, ref.ref, sha1),
      source: 'plane_comment_inline',
      filename: ref.filename,
      mime_type: ref.mime_type,
      size: 0,
      uploaded_at: comment.created_at,
      ...(comment.actor !== undefined && comment.actor.length > 0
        ? { uploaded_by: comment.actor }
        : {}),
      comment_id: comment.id,
      storage: {
        kind: 'minio',
        bucket: ref.bucket,
        object_key: ref.object_key,
      },
    }));
}

export function extractInlineAssetRefs(
  html: string,
  options: CommentAssetsOptions,
): InlineAssetRef[] {
  if (html.length === 0) return [];

  const allowedMinioOrigins = new Set(
    options.minioEndpoints
      .map((e) => normaliseOrigin(e))
      .filter((o): o is string => o !== null),
  );
  const allowedPlaneOrigins = new Set(
    (options.planeAssetEndpoints ?? [])
      .map((e) => normaliseOrigin(e))
      .filter((o): o is string => o !== null),
  );

  const root = parseHtml(html);
  // Источники URL: <img src>, <a href> (на файл в plane-uploads),
  // <source src>, <video src>. Выкидываем нерелевантные.
  const candidates: string[] = [];
  for (const tag of ['img', 'source', 'video'] as const) {
    for (const el of root.querySelectorAll(tag)) {
      const src = el.getAttribute('src');
      if (src !== undefined && src !== null) candidates.push(src);
    }
  }
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (href !== undefined && href !== null) candidates.push(href);
  }
  for (const image of root.querySelectorAll('image-component')) {
    for (const attr of ['src', 'asset', 'asset_id'] as const) {
      const assetId = parsePlaneAssetId(image.getAttribute(attr));
      if (assetId !== null) {
        candidates.push(`plane-asset:${assetId}`);
        break;
      }
    }
  }

  const seen = new Set<string>();
  const out: InlineAssetRef[] = [];
  for (const raw of candidates) {
    if (raw.startsWith('plane-asset:')) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push({
        kind: 'plane_asset',
        ref: raw,
        asset_id: raw.slice('plane-asset:'.length),
      });
      continue;
    }

    const safe = parseSafeUrl(raw);
    if (safe === null) continue;
    const planeAssetId = parsePlaneAssetApiUrl(safe, allowedPlaneOrigins);
    if (planeAssetId !== null) {
      if (seen.has(safe.href)) continue;
      seen.add(safe.href);
      out.push({ kind: 'plane_asset', ref: safe.href, asset_id: planeAssetId });
      continue;
    }

    if (!allowedMinioOrigins.has(safe.origin)) continue;
    // path: /<bucket>/<...key...>. Нормализованный pathname без `..`
    // (parseSafeUrl уже это проверил). Первый сегмент = bucket plane.
    const segments = safe.pathname.split('/').filter((s) => s.length > 0);
    if (segments.length < 2) continue;
    if (segments[0] !== options.planeBucket) continue;
    const objectKey = segments.slice(1).join('/');
    if (objectKey.length === 0) continue;
    // Дедупликация одинаковых URL внутри одного комментария.
    if (seen.has(safe.href)) continue;
    seen.add(safe.href);

    const filename = decodeFilename(segments[segments.length - 1] ?? objectKey);
    const mimeType = inferMimeFromFilename(filename);
    out.push({
      kind: 'minio',
      ref: safe.href,
      filename,
      mime_type: mimeType,
      bucket: options.planeBucket,
      object_key: objectKey,
    });
  }
  return out;
}

/**
 * Безопасный парсер URL: возвращает null, если URL невалиден,
 * относителен, или содержит path-traversal-сегменты (`..`, `.`).
 *
 * `new URL(...)` сам нормализует `..` в pathname (`/a/../b` → `/b`), но
 * только если в URL уже есть scheme/host. Дополнительно отказываем в
 * URL'ах, у которых pathname после `decodeURI` содержит подстроку `..`
 * — это защищает от закодированных `%2e%2e` и других кривых форм
 * (защита глубже, чем нужно, но стоит дёшево).
 *
 * Accepted risk (см. security-review SLONK-14):
 *
 * 1. **Double-encoded path-traversal** (`%252e%252e/`, `%25252e…`):
 *    `decodeURI` снимает только один слой percent-encoding. После
 *    одного раунда `%252e` → `%2e`, что не содержит подстроку `..`
 *    (decoded[‘.’,‘.’] не получаем), и проверка проходит. Это **не**
 *    эксплуатируется в нашей модели: получившийся `object_key` всё
 *    равно проверяется по bucket-whitelist (`segments[0] === planeBucket`),
 *    и S3-keys у нас плоские (`issues/<uuid>/<filename>`) — каталоговая
 *    структура без `..`-сегментов на стороне MinIO. Чинить здесь нет
 *    смысла без перехода на полный recursive decode-loop, который
 *    создаст риск infinite-loop на патологически закодированных URL.
 *
 * 2. **Null-byte / CRLF в pathname** (`%00`, `%0d`, `%0a`):
 *    `new URL` сохраняет их в `pathname` дословно (`%00` остаётся `%00`).
 *    Дальше они уходят в `object_key`, который передаётся в MinIO SDK.
 *    MinIO SDK сам percent-encode'ит ключ перед запросом, поэтому
 *    request-smuggling/header-injection не получается. На уровень
 *    log-injection пробить тоже не выйдет: pino сериализует строки в
 *    JSON, экранируя управляющие символы. Принимаем риск.
 */
function parseSafeUrl(raw: string): { origin: string; pathname: string; href: string } | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    let decoded: string;
    try {
      decoded = decodeURI(u.pathname);
    } catch {
      return null;
    }
    if (decoded.includes('..')) return null;
    const segments = u.pathname.split('/');
    if (segments.some((s) => s === '..' || s === '.')) return null;
    return {
      origin: `${u.protocol}//${u.host}`,
      pathname: u.pathname,
      href: u.href,
    };
  } catch {
    return null;
  }
}

/**
 * Нормализация endpoint-строки (`http://minio:9000`) в origin
 * (`http://minio:9000`). Возвращает null для невалидных URL — это
 * означает «не доверяем», то есть аналогично «нет такого endpoint».
 */
function normaliseOrigin(endpoint: string): string | null {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function parsePlaneAssetId(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    ? s
    : null;
}

function parsePlaneAssetApiUrl(
  safe: { origin: string; pathname: string; href: string },
  allowedPlaneOrigins: Set<string>,
): string | null {
  if (!allowedPlaneOrigins.has(safe.origin)) return null;
  if (!safe.pathname.startsWith('/api/assets/')) return null;
  const match = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(
    safe.pathname,
  );
  return match?.[1] ?? null;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function decodeFilename(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  md: 'text/markdown',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

function inferMimeFromFilename(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
