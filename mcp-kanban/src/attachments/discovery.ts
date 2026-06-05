import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { PlaneClient } from '../plane-client.js';
import type { MinioClient } from '../minio-client.js';
import { extractInlineAssets } from './comment-assets.js';
import { mcaIdFromObjectKey, type Attachment, type AttachmentSource } from './types.js';

// Discovery: три источника вложений запускаются параллельно через
// allSettled, ошибка одного → `partial: true`, остальные продолжают
// работать (см. design §6, ТЗ AC №4).

export interface DiscoveryFilters {
  source?: AttachmentSource | 'all';
  comment_id?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}

export interface DiscoveryResult {
  items: Attachment[];
  next_cursor?: string;
  total: number;
  partial: boolean;
  /** Список source'ов, которые упали — для логирования. */
  failed_sources: AttachmentSource[];
}

export interface DiscoveryDeps {
  plane: PlaneClient;
  minio: MinioClient;
  logger: Logger;
  workspace: string;
  projectId: string;
  issueId: string;
  planeBucket: string;
  mcpBucket: string;
  minioEndpoints: string[];
  filters?: DiscoveryFilters;
}

export async function discoverAttachments(deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const filters = deps.filters ?? {};
  const wantedSource = filters.source ?? 'all';

  type SourceResult = { source: AttachmentSource; items: Attachment[] };

  const tasks: { source: AttachmentSource; run: () => Promise<Attachment[]> }[] = [];
  if (wantedSource === 'all' || wantedSource === 'plane_issue') {
    tasks.push({ source: 'plane_issue', run: () => fromPlaneIssue(deps) });
  }
  if (wantedSource === 'all' || wantedSource === 'plane_comment_inline') {
    tasks.push({ source: 'plane_comment_inline', run: () => fromCommentInline(deps) });
  }
  if (wantedSource === 'all' || wantedSource === 'mcp_artifact') {
    tasks.push({ source: 'mcp_artifact', run: () => fromMcpArtifact(deps) });
  }

  const settled = await Promise.allSettled(
    tasks.map(async (t) => ({ source: t.source, items: await t.run() })),
  );

  const merged: Attachment[] = [];
  const failed: AttachmentSource[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    const taskSource = tasks[i]!.source;
    if (result.status === 'fulfilled') {
      const value = result.value as SourceResult;
      merged.push(...value.items);
    } else {
      failed.push(taskSource);
      deps.logger.warn(
        {
          source: taskSource,
          issue_id: deps.issueId,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        'attachments discovery: source failed',
      );
    }
  }

  // Filters, применяемые после merge.
  let filtered = merged;
  if (filters.comment_id !== undefined) {
    filtered = filtered.filter((a) => a.comment_id === filters.comment_id);
  }
  if (filters.since !== undefined) {
    const sinceMs = Date.parse(filters.since);
    if (Number.isFinite(sinceMs)) {
      filtered = filtered.filter((a) => {
        const t = Date.parse(a.uploaded_at);
        return Number.isFinite(t) && t >= sinceMs;
      });
    }
  }

  // Sort uploaded_at DESC. NaN dates сваливаем в конец (стабильность через
  // вторичный ключ id).
  filtered.sort((a, b) => {
    const ta = Date.parse(a.uploaded_at);
    const tb = Date.parse(b.uploaded_at);
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return a.id.localeCompare(b.id);
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    if (ta !== tb) return tb - ta;
    return a.id.localeCompare(b.id);
  });

  const total = filtered.length;
  const limit = filters.limit ?? 50;
  const offset = parseCursor(filters.cursor);
  const page = filtered.slice(offset, offset + limit);
  const next = offset + limit < total ? encodeCursor(offset + limit) : undefined;

  return {
    items: page,
    ...(next !== undefined ? { next_cursor: next } : {}),
    total,
    partial: failed.length > 0,
    failed_sources: failed,
  };
}

// ---------------- source 1: plane_issue ----------------

async function fromPlaneIssue(deps: DiscoveryDeps): Promise<Attachment[]> {
  const list = await deps.plane.listIssueAttachments(deps.workspace, deps.projectId, deps.issueId);
  return list.map((p) => ({
    id: `pi_${p.id}`,
    source: 'plane_issue' as const,
    filename: p.attributes.name,
    mime_type: p.attributes.type,
    size: p.attributes.size,
    uploaded_at: p.created_at,
    ...(p.created_by !== undefined ? { uploaded_by: p.created_by } : {}),
    storage: {
      bucket: deps.planeBucket,
      object_key: p.asset,
    },
  }));
}

// ---------------- source 2: plane_comment_inline ----------------

async function fromCommentInline(deps: DiscoveryDeps): Promise<Attachment[]> {
  const comments = await deps.plane.listIssueComments(deps.workspace, deps.projectId, deps.issueId);
  const out: Attachment[] = [];
  for (const c of comments) {
    const items = extractInlineAssets(c, {
      minioEndpoints: deps.minioEndpoints,
      planeBucket: deps.planeBucket,
    });
    // Подтягиваем `size` через statObject — это +N round-trips, но без
    // этого `size` остаётся 0 и AC #1 не выполняется. Не падаем на
    // отдельных ошибках statObject — оставляем size=0 и продолжаем
    // (отдельный комментарий мог содержать ссылку на удалённый файл).
    for (const item of items) {
      try {
        const stat = await deps.minio.statObject(item.storage.bucket, item.storage.object_key);
        item.size = stat.size;
        if (stat.contentType !== undefined && stat.contentType.length > 0) {
          item.mime_type = stat.contentType;
        }
      } catch (err) {
        deps.logger.warn(
          {
            issue_id: deps.issueId,
            comment_id: c.id,
            object_key: item.storage.object_key,
            err: err instanceof Error ? err.message : String(err),
          },
          'inline asset stat failed; keeping size=0',
        );
      }
      out.push(item);
    }
  }
  return out;
}

// ---------------- source 3: mcp_artifact ----------------

async function fromMcpArtifact(deps: DiscoveryDeps): Promise<Attachment[]> {
  const prefix = `issues/${deps.issueId}/`;
  const objects = await deps.minio.listObjectsV2(deps.mcpBucket, prefix);
  const out: Attachment[] = [];
  for (const obj of objects) {
    const parsed = parseMcaObjectKey(obj.key);
    const filename = parsed.filename ?? lastSegment(obj.key);
    out.push({
      id: mcaIdFromObjectKey(obj.key, sha1),
      source: 'mcp_artifact',
      filename,
      mime_type: inferMime(filename),
      size: obj.size,
      uploaded_at: parsed.uploadedAt ?? (obj.lastModified?.toISOString() ?? new Date(0).toISOString()),
      ...(parsed.uploadedBy !== undefined ? { uploaded_by: parsed.uploadedBy } : {}),
      storage: {
        bucket: deps.mcpBucket,
        object_key: obj.key,
      },
    });
  }
  return out;
}

/**
 * Object-key формат из attach-file/handler.ts::makeObjectKey:
 * `issues/<issueId>/<ts>-<identity>-<filename>`. Разбор обратный.
 * Если формат не совпадает (legacy/чужие объекты) — все поля undefined,
 * вызывающий fallback'нётся на lastSegment+lastModified.
 */
/**
 * Object-key из `attach-file/handler.ts::makeObjectKey` имеет форму
 * `issues/<issueId>/<ts>-<identity>-<filename>`. Идентичности агентов —
 * `analyst-agent`, `developer-agent`, и т.п. — содержат дефис, и filename
 * тоже может содержать дефисы. Однозначно разобрать ключ нельзя, поэтому
 * ищем известные agent-suffix'ы: первый `<ts>-<role>-agent-` совпадает.
 *
 * Если паттерн не нашёлся — пустой результат, fallback на lastSegment+
 * lastModified в вызывающем коде.
 */
function parseMcaObjectKey(
  key: string,
): { uploadedAt?: string; uploadedBy?: string; filename?: string } {
  const m = /^issues\/[^/]+\/(\d+)-([a-z][a-z0-9_-]*-agent)-(.+)$/i.exec(key);
  if (m === null) return {};
  const ts = Number.parseInt(m[1]!, 10);
  const identity = m[2]!;
  const filename = m[3]!;
  if (!Number.isFinite(ts)) return { uploadedBy: identity, filename };
  return {
    uploadedAt: new Date(ts).toISOString(),
    uploadedBy: identity,
    filename,
  };
}

function lastSegment(key: string): string {
  const segs = key.split('/');
  return segs[segs.length - 1] ?? key;
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
};

function inferMime(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

// ---------------- cursor (opaque base64 JSON {offset:N}) ----------------

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const obj = JSON.parse(decoded) as { offset?: number };
    const off = obj.offset;
    if (typeof off === 'number' && Number.isFinite(off) && off >= 0) return Math.floor(off);
  } catch {
    // ignore — некорректный cursor → начнём с offset 0
  }
  return 0;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}
