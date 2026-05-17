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
}

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
  const html = comment.comment_html ?? '';
  if (html.length === 0) return [];

  const allowedOrigins = new Set(
    options.minioEndpoints
      .map((e) => normaliseOrigin(e))
      .filter((o): o is string => o !== null),
  );
  if (allowedOrigins.size === 0) return [];

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

  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const raw of candidates) {
    const safe = parseSafeUrl(raw);
    if (safe === null) continue;
    if (!allowedOrigins.has(safe.origin)) continue;
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
      id: pciIdFromAsset(comment.id, safe.href, sha1),
      source: 'plane_comment_inline',
      filename,
      mime_type: mimeType,
      size: 0,
      uploaded_at: comment.created_at,
      ...(comment.actor !== undefined && comment.actor.length > 0
        ? { uploaded_by: comment.actor }
        : {}),
      comment_id: comment.id,
      storage: {
        bucket: options.planeBucket,
        object_key: objectKey,
      },
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
