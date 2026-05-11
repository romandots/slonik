import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

// Парсер машинно-читаемого блока в описании задачи. См. SPEC.md §5.6.
//
//   ---
//   <!-- slonk:meta v1 -->
//   repos:
//     - url: https://github.com/acme/backend
//       branch: feature/SLONK-123-auth-flow
//       pr: https://github.com/acme/backend/pull/456
//       commits:
//         - 4f1a2b3
//
// Маркер `<!-- slonk:meta v1 -->` обязателен. До маркера — произвольный
// текст (контент описания), после — строгий YAML. Парсер идемпотентен:
// `serialize(parse(text)) === stripped meta block`.

export const MetaBlockMarker = '<!-- slonk:meta v1 -->';

const Sha = z.string().regex(/^[0-9a-f]{7,40}$/, 'expected commit sha (7..40 hex chars)');

const GitRef = z.object({
  url: z.string().url(),
  branch: z.string().min(1).optional(),
  pr: z.string().url().optional(),
  commits: z.array(Sha).default([]),
});

export const MetaBlockSchema = z.object({
  repos: z.array(GitRef).default([]),
});

export type MetaBlock = z.infer<typeof MetaBlockSchema>;
export type GitRef = z.infer<typeof GitRef>;

export interface ParsedDescription {
  /** Описание без meta-блока. */
  body: string;
  /** Распарсенный meta. Если блока нет — пустая структура. */
  meta: MetaBlock;
  /** True, если блок присутствовал, но не парсится. Поднимает needs-human. */
  corrupt: boolean;
  /** Сообщение об ошибке парсинга (если corrupt). */
  error?: string;
}

const HEADER_RE = new RegExp(`(^|\\n)---\\s*\\n${escapeRe(MetaBlockMarker)}\\s*\\n`, 'm');

/**
 * Разрезает описание на body + meta. Никогда не выбрасывает: повреждённый
 * блок помечается `corrupt:true`, и MCP-логика решает, что делать
 * (обычно — пометить `needs-human`).
 */
export function parseDescription(text: string | null | undefined): ParsedDescription {
  if (text === null || text === undefined || text.length === 0) {
    return { body: '', meta: { repos: [] }, corrupt: false };
  }
  const match = HEADER_RE.exec(text);
  if (match === null) {
    return { body: text, meta: { repos: [] }, corrupt: false };
  }
  const splitAt = match.index + match[0].length;
  // Иногда в описании на одной задаче может оказаться несколько блоков
  // (исторический мусор). Берём первый, остальное оставляем «как есть»
  // в body — claim'ить ничей не будем.
  const body = text.slice(0, match.index).replace(/[\s\n]+$/, '');
  const yamlBlock = text.slice(splitAt);
  try {
    const raw = parseYaml(yamlBlock) as unknown;
    const result = MetaBlockSchema.safeParse(raw ?? { repos: [] });
    if (!result.success) {
      return {
        body,
        meta: { repos: [] },
        corrupt: true,
        error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    return { body, meta: result.data, corrupt: false };
  } catch (err) {
    return {
      body,
      meta: { repos: [] },
      corrupt: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Собирает описание обратно: body + маркер + YAML. Если meta пуст —
 * возвращает только body.
 */
export function serializeDescription(body: string, meta: MetaBlock): string {
  const trimmedBody = body.replace(/[\s\n]+$/, '');
  const hasMeta = meta.repos.length > 0;
  if (!hasMeta) return trimmedBody;
  const yaml = stringifyYaml(meta).replace(/[\s\n]+$/, '');
  const header = trimmedBody.length > 0 ? `${trimmedBody}\n\n---\n` : `---\n`;
  return `${header}${MetaBlockMarker}\n${yaml}\n`;
}

/**
 * Идемпотентное добавление git-связки. Дедуп по `(url, commit)`; если
 * commit отсутствует — по `(url, branch||pr)`.
 */
export function upsertGitRef(meta: MetaBlock, ref: GitRef): MetaBlock {
  const repos = meta.repos.map(cloneRef);
  const existingIdx = repos.findIndex((r) => sameRef(r, ref));
  if (existingIdx === -1) {
    repos.push(cloneRef(ref));
    return { repos };
  }
  const existing = repos[existingIdx]!;
  const merged: GitRef = {
    url: ref.url,
    ...(ref.branch !== undefined ? { branch: ref.branch } : existing.branch !== undefined ? { branch: existing.branch } : {}),
    ...(ref.pr !== undefined ? { pr: ref.pr } : existing.pr !== undefined ? { pr: existing.pr } : {}),
    commits: dedupe([...existing.commits, ...ref.commits]),
  };
  repos[existingIdx] = merged;
  return { repos };
}

export function removeGitRef(meta: MetaBlock, ref: { url: string; commit?: string }): MetaBlock {
  const repos: GitRef[] = [];
  for (const r of meta.repos) {
    if (r.url !== ref.url) {
      repos.push(cloneRef(r));
      continue;
    }
    if (ref.commit === undefined) {
      continue;
    }
    const commits = r.commits.filter((c) => c !== ref.commit);
    if (commits.length === 0 && r.branch === undefined && r.pr === undefined) {
      continue;
    }
    repos.push({ ...cloneRef(r), commits });
  }
  return { repos };
}

/**
 * Recovery для повреждённого meta-блока (SPEC §5.6: «не разрушает описание —
 * пишет валидный блок рядом и помечает `needs-human`»). Берёт исходный
 * raw-description (где меж маркером и YAML-блоком сломан YAML), пакует
 * сломанный блок в `<details>`-комментарий и возвращает body, в конец
 * которого можно безопасно дописать свежий валидный meta.
 *
 * Возвращает `{ recovered: false }`, если HEADER не найден (нечего
 * recover'ить).
 */
export function preserveCorruptDescription(rawDescription: string): {
  recovered: boolean;
  body: string;
  quoted: string;
} {
  const match = HEADER_RE.exec(rawDescription);
  if (match === null) return { recovered: false, body: rawDescription, quoted: '' };
  const before = rawDescription.slice(0, match.index).replace(/[\s\n]+$/, '');
  const corruptBlock = rawDescription.slice(match.index + match[0].length);
  // Экранируем потенциальные fenced-блоки в самом мусоре, чтобы наш
  // wrapper не сломался.
  const safeFence = pickSafeFence(corruptBlock);
  const quoted =
    `<!-- slonk:corrupt-meta-preserved -->\n` +
    `${safeFence}yaml\n${corruptBlock.trimEnd()}\n${safeFence}\n`;
  return { recovered: true, body: before, quoted };
}

function pickSafeFence(content: string): string {
  let len = 3;
  // Если внутри сохранённого блока есть ` ``` `, используем более длинный
  // забор, чем самая длинная последовательность бэктиков.
  const matches = content.match(/`{3,}/g);
  if (matches !== null) {
    for (const m of matches) {
      if (m.length >= len) len = m.length + 1;
    }
  }
  return '`'.repeat(len);
}

function sameRef(a: GitRef, b: GitRef): boolean {
  // Одинаковый repo url — считаем одной записью; merge politики решают, как
  // объединить branch/pr/commits. Это соответствует контракту SPEC §6.5:
  // link_git_ref идемпотентен; разные коммиты под одним репо живут в общем
  // списке `commits`, а не в отдельных entries.
  return a.url === b.url;
}

function cloneRef(r: GitRef): GitRef {
  return {
    url: r.url,
    ...(r.branch !== undefined ? { branch: r.branch } : {}),
    ...(r.pr !== undefined ? { pr: r.pr } : {}),
    commits: [...r.commits],
  };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
