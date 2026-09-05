// SLONK-37: фильтрация задач живёт здесь, а не в query-string к Plane.
//
// Публичный list-эндпоинт Plane v1.3.0 неизвестные ему query-параметры
// молча игнорирует: `state`, `labels`, `search` уезжали на сервер и не
// делали ничего — инструмент отдавал «последние N задач проекта» и выглядел
// при этом абсолютно правдоподобно. Худший вид отказа: не отличим от
// честного ответа.
//
// Поэтому: Plane отдаёт страницы (`plane.listIssuesPage`), а решение
// «подходит / не подходит» принимают чистые функции этого модуля. Ошибка в
// имени фильтра здесь тоже не молчит — см. `resolveStates` / `resolvePriorities`.

import type { PlaneIssue, PlaneLabel, PlaneState, PlaneUser } from '../../plane-client.js';
import { McpError } from '../../errors.js';

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;

/**
 * Разобранный набор ограничений.
 *
 * Соглашение по каждому полю:
 *   - `undefined`      — ограничения нет;
 *   - непустой массив  — OR по значениям;
 *   - **пустой массив** — не подходит ничего (так выражается «фильтр задан,
 *     но ни одно значение не существует на доске» — например несуществующий
 *     лейбл).
 */
export interface IssueFilter {
  states?: string[];
  labels?: string[];
  assignees?: string[];
  priorities?: string[];
  cycle?: string;
  module?: string;
  /** Подстрока полнотекстового поиска, уже приведённая к нижнему регистру. */
  query?: string;
}

/** Подходит ли задача под все заданные ограничения. */
export function issueMatches(issue: PlaneIssue, filter: IssueFilter, key?: string): boolean {
  if (filter.states !== undefined && !filter.states.includes(issue.state)) return false;
  if (filter.labels !== undefined && !issue.labels.some((l) => filter.labels?.includes(l))) {
    return false;
  }
  if (
    filter.assignees !== undefined &&
    !issue.assignees.some((a) => filter.assignees?.includes(a))
  ) {
    return false;
  }
  if (filter.priorities !== undefined && !filter.priorities.includes(issue.priority ?? 'none')) {
    return false;
  }
  if (filter.cycle !== undefined && issue.cycle !== filter.cycle) return false;
  if (filter.module !== undefined && issue.module !== filter.module) return false;
  if (filter.query !== undefined && !searchableText(issue, key).includes(filter.query)) {
    return false;
  }
  return true;
}

/**
 * Текст, по которому ищет `search_issues`: заголовок, ключ (`SLONK-37`) и
 * тело задачи с вырезанной HTML-разметкой. Комментарии не индексируются —
 * это отдельный запрос к Plane на каждую задачу, что превратило бы поиск по
 * доске в сотни round-trip'ов.
 */
export function searchableText(issue: PlaneIssue, key?: string): string {
  const body = issue.description_html ?? issue.description ?? '';
  return [key ?? '', issue.name, stripHtml(body)].join('\n').toLowerCase();
}

/** Грубое, но достаточное для поиска извлечение текста из HTML тела задачи. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * Имена/UUID состояний → id.
 *
 * Опечатка — **ошибка**, а не пустая выборка и тем более не «вся доска».
 * Состояния на доске перечислимы, и агент, попросивший `To DO` вместо
 * `To Do`, должен узнать об этом сразу.
 */
export function resolveStates(
  input: string | string[] | undefined,
  states: PlaneState[],
): string[] | undefined {
  const refs = normalise(input);
  if (refs === undefined) return undefined;
  return refs.map((ref) => {
    const hit = matchByIdOrName(ref, states);
    if (hit === undefined) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message:
          `Unknown state: ${ref}. Known states in this project: ` +
          `${states.map((s) => s.name).join(', ')}.`,
      });
    }
    return hit.id;
  });
}

/**
 * Имена/UUID лейблов → id.
 *
 * В отличие от состояний, несуществующий лейбл — не ошибка, а **пустая
 * выборка**: «задач с таким лейблом нет» — корректный и ожидаемый ответ,
 * а лейблы заводятся по ходу работы. Важно лишь то, что выборка пустая, а
 * не «вся доска».
 */
export function resolveLabels(
  input: string | string[] | undefined,
  labels: PlaneLabel[],
): string[] | undefined {
  const refs = normalise(input);
  if (refs === undefined) return undefined;
  return refs
    .map((ref) => matchByIdOrName(ref, labels)?.id)
    .filter((id): id is string => id !== undefined);
}

/** Значения приоритета; неизвестное — ошибка (набор закрытый). */
export function resolvePriorities(input: string | string[] | undefined): string[] | undefined {
  const refs = normalise(input);
  if (refs === undefined) return undefined;
  return refs.map((ref) => {
    const value = ref.toLowerCase();
    if (!(PRIORITIES as readonly string[]).includes(value)) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `Unknown priority: ${ref}. Allowed: ${PRIORITIES.join(', ')}.`,
      });
    }
    return value;
  });
}

/**
 * Исполнители: UUID участника, e-mail или display_name → id.
 * Неизвестный участник — ошибка: список участников workspace конечен.
 */
export function resolveAssignees(
  input: string | string[] | undefined,
  members: PlaneUser[],
): string[] | undefined {
  const refs = normalise(input);
  if (refs === undefined) return undefined;
  return refs.map((ref) => {
    const needle = ref.toLowerCase();
    const hit = members.find(
      (m) =>
        m.id === ref ||
        m.email?.toLowerCase() === needle ||
        m.display_name?.toLowerCase() === needle,
    );
    if (hit === undefined) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message:
          `Unknown assignee: ${ref}. Pass a workspace member id, e-mail or display name.`,
      });
    }
    return hit.id;
  });
}

function normalise(input: string | string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  const arr = Array.isArray(input) ? input : [input];
  // Пустой массив трактуем как «фильтр не задан» — иначе `state: []` тихо
  // отдавал бы пустую выборку на ровном месте.
  return arr.length === 0 ? undefined : arr;
}

function matchByIdOrName<T extends { id: string; name: string }>(
  ref: string,
  collection: T[],
): T | undefined {
  return (
    collection.find((c) => c.id === ref) ??
    collection.find((c) => c.name === ref) ??
    collection.find((c) => c.name.toLowerCase() === ref.toLowerCase())
  );
}
