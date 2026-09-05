// SLONK-37: постраничный обход задач проекта с фильтрацией на нашей стороне.
//
// Plane отдаёт задачи страницами в порядке `created_at DESC` и не умеет
// фильтровать (см. `filter.ts`). Значит, чтобы «доска длиннее одной страницы
// перечислялась целиком», нужен курсор наружу — иначе всё, что старше первой
// сотни карточек, недостижимо ни одним запросом.
//
// Курсор наш собственный, а не Plane'овский: остановиться приходится в
// середине страницы (набрали `limit` совпадений), и продолжить надо ровно с
// той же позиции — ни пропустив, ни повторив задачу. Поэтому в курсоре два
// поля: `c` — курсор страницы у Plane, `o` — сколько элементов этой страницы
// уже отдано.

import type { PlaneClient, PlaneIssue } from '../../plane-client.js';
import { McpError } from '../../errors.js';

/** Размер страницы, которую тянем у Plane за один round-trip. */
export const PAGE_SIZE = 100;

/**
 * Потолок страниц за один вызов инструмента. Обход не бесконечный: если
 * фильтр разрежённый и `limit` не набрался — возвращаем курсор и говорим об
 * этом честно (`has_more: true`), вместо того чтобы тянуть всю доску в память
 * одним запросом (см. SLONK-5 про memory pressure на маленьком хосте).
 */
export const MAX_PAGES_PER_CALL = 10;

export interface ScanCursor {
  /** Курсор страницы Plane; `undefined` — первая страница. */
  c?: string;
  /** Сколько элементов этой страницы уже отдано. */
  o: number;
}

export interface ScanResult {
  issues: PlaneIssue[];
  /** Непрозрачный курсор продолжения; `undefined` — доска пройдена до конца. */
  nextCursor?: string;
  /** Сколько задач проекта просмотрено за этот вызов. */
  scanned: number;
}

export async function scanIssues(deps: {
  plane: PlaneClient;
  workspace: string;
  projectId: string;
  limit: number;
  cursor?: string;
  /** Вызывается для КАЖДОЙ просмотренной задачи — в том числе не подошедшей. */
  match: (issue: PlaneIssue) => boolean;
  /** Загрузчик страницы; переопределяется тестами и кешем. */
  fetchPage?: (cursor: string | undefined) => Promise<{ items: PlaneIssue[]; nextCursor?: string }>;
}): Promise<ScanResult> {
  const start = decodeCursor(deps.cursor);
  const fetchPage =
    deps.fetchPage ??
    (async (cursor: string | undefined) =>
      await deps.plane.listIssuesPage(deps.workspace, deps.projectId, {
        perPage: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      }));

  const issues: PlaneIssue[] = [];
  let scanned = 0;
  let pageCursor = start.c;
  let skip = start.o;

  for (let page = 0; page < MAX_PAGES_PER_CALL; page += 1) {
    const { items, nextCursor } = await fetchPage(pageCursor);

    for (let idx = skip; idx < items.length; idx += 1) {
      const issue = items[idx];
      if (issue === undefined) continue;
      scanned += 1;
      if (!deps.match(issue)) continue;
      if (issues.length >= deps.limit) {
        // Лимит набран, а совпадения ещё есть: курсор указывает ровно на эту
        // задачу — на следующем вызове обход продолжится с неё.
        return { issues, nextCursor: encodeCursor({ ...(pageCursor !== undefined ? { c: pageCursor } : {}), o: idx }), scanned };
      }
      issues.push(issue);
    }
    skip = 0;

    // `nextCursor === pageCursor` — защита от Plane, который отдаёт курсор
    // на самого себя: без неё обход зациклился бы на одной странице.
    if (items.length === 0 || nextCursor === undefined || nextCursor === pageCursor) {
      // Доска пройдена до конца — курсора продолжения нет.
      return { issues, scanned };
    }
    pageCursor = nextCursor;
  }

  // Упёрлись в потолок страниц: продолжение возможно, начиная со следующей.
  return {
    issues,
    nextCursor: encodeCursor({ ...(pageCursor !== undefined ? { c: pageCursor } : {}), o: 0 }),
    scanned,
  };
}

export function encodeCursor(cursor: ScanCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): ScanCursor {
  if (raw === undefined) return { o: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw badCursor(raw);
  }
  if (typeof parsed !== 'object' || parsed === null) throw badCursor(raw);
  const { c, o } = parsed as { c?: unknown; o?: unknown };
  if (c !== undefined && typeof c !== 'string') throw badCursor(raw);
  if (typeof o !== 'number' || !Number.isInteger(o) || o < 0) throw badCursor(raw);
  return { ...(c !== undefined ? { c } : {}), o };
}

function badCursor(raw: string): McpError {
  return new McpError({
    code: 'INVALID_INPUT',
    message:
      `Malformed cursor: ${raw.slice(0, 32)}. Pass back the \`next_cursor\` ` +
      `returned by the previous call, unchanged.`,
  });
}
