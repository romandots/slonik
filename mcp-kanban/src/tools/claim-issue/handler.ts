import type { PlaneClient, PlaneIssue, PlaneLabel, PlaneState } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import type { AuditLog } from '../../audit.js';
import type { IdentityStore } from '../../bootstrap/store.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import { type ClaimIssueInput } from './schema.js';

const CLAIMED_LABEL = 'agent-claimed';

export interface ClaimIssueResult extends IssueSummary {
  claimed_by: AgentIdentity;
  trace_id: string;
}

export async function claimIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  audit: AuditLog;
  /**
   * IdentityStore — источник правды для `default_state` и `state_aliases`
   * (SLONK-6). Если стор пуст или не содержит записи для текущей identity,
   * tool падает `INVALID_INPUT` с подсказкой запустить `make bootstrap`.
   */
  identityStore: IdentityStore;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  identity: AgentIdentity;
  traceId: string;
  /** plane_user_id текущей identity, если known (per_user mode). */
  planeUserId: string | null;
  input: ClaimIssueInput;
}): Promise<ClaimIssueResult> {
  const parsed = parseIssueRef(deps.input.issue_id);
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined
      ? { projectRef: deps.input.project }
      : parsed.kind === 'sequence' && parsed.identifier !== undefined
        ? { projectRef: parsed.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });

  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsed);

  // Atomic claim: вставка в SQLite — single-source-of-truth для race-condition.
  // Если запись уже есть — кто-то нас опередил.
  const acquired = deps.audit.tryAcquireClaim({
    issue_id: issueId,
    identity: deps.identity,
    trace_id: deps.traceId,
  });
  if (!acquired) {
    const current = deps.audit.currentClaim(issueId);
    throw new McpError({
      code: 'CONFLICT',
      message: `Issue already claimed by ${current?.identity ?? 'another agent'}`,
    });
  }

  try {
    const [states, labels] = await Promise.all([
      deps.plane.listStates(deps.workspace, project.id),
      deps.plane.listLabels(deps.workspace, project.id),
    ]);
    const claimedLabel = labels.find((l) => l.name === CLAIMED_LABEL);
    if (claimedLabel === undefined) {
      throw new McpError({
        code: 'INTERNAL',
        message: `Label '${CLAIMED_LABEL}' is missing; run bootstrap to create it`,
      });
    }

    // SLONK-6: маппинг роль → колонка живёт в IdentityStore. target_state
    // в input'е (если передан) — override; иначе берём default_state из стора.
    const mapping = deps.identityStore.get(deps.identity);
    const requestedStateName = deps.input.target_state ?? mapping?.default_state ?? undefined;
    if (requestedStateName === undefined) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message:
          `No default state mapped for identity '${deps.identity}'. ` +
          'Either pass target_state explicitly or set `default_state` ' +
          `in roles/${deps.identity}.md and re-run \`make bootstrap\`.`,
      });
    }
    const aliases = mapping?.state_aliases ?? [];
    const stateId = resolveStateWithAliases(requestedStateName, aliases, states, {
      identity: deps.identity,
      projectIdentifier: project.identifier,
    });
    // Используем фактическое имя найденной колонки для комментария,
    // чтобы оператор видел, во что именно превратился alias.
    const targetStateName = states.find((s) => s.id === stateId)?.name ?? requestedStateName;

    // Plane: получить актуальные ярлыки/assignees, добавить наши, патчить.
    const issue = await deps.plane.getIssue(deps.workspace, project.id, issueId);
    if (issue === undefined) {
      throw new McpError({ code: 'NOT_FOUND', message: `Issue ${issueId} disappeared during claim` });
    }
    const nextLabels = dedupe([...issue.labels, claimedLabel.id]);
    const nextAssignees =
      deps.planeUserId !== null
        ? dedupe([...issue.assignees, deps.planeUserId])
        : issue.assignees;

    const updated = (await deps.plane.updateIssue(deps.workspace, project.id, issueId, {
      labels: nextLabels,
      assignees: nextAssignees,
      state: stateId,
    })) as PlaneIssue;

    await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
      comment_html: formatComment(
        deps.identity,
        `claimed; moved to <em>${targetStateName}</em>.`,
      ),
    });

    deps.cache.clear();

    return {
      ...summarise(updated, states, labels, project.identifier),
      claimed_by: deps.identity,
      trace_id: deps.traceId,
    };
  } catch (err) {
    // Откатываем claim — Plane не успел поменяться, поэтому БД-claim
    // снимаем, чтобы повтор был возможен.
    try {
      deps.audit.releaseClaim({ issue_id: issueId, identity: deps.identity });
    } catch {
      // Глотаем: либо запись уже снята, либо БД упала; внешнюю ошибку
      // важно сохранить.
    }
    throw err;
  }
}

/**
 * Резолвит имя колонки в `state_id` с учётом `state_aliases` из IdentityStore.
 *
 * Шаги (по убыванию приоритета):
 *   1. совпадение по `state.id` (если в input передали UUID);
 *   2. case-sensitive совпадение `state.name === ref`;
 *   3. case-insensitive совпадение по имени;
 *   4. case-insensitive совпадение по одному из `aliases`, при котором имя
 *      колонки тоже совпадает с одним из aliases (т.е. user сказал
 *      «Разработка», и в Plane колонка тоже названа «Разработка»);
 *   5. case-insensitive совпадение между `ref` и `aliases`: если ref —
 *      один из aliases, ищем колонку, имя которой совпадает с
 *      `default_state` (передаваемый как первый alias по конвенции
 *      `roles/*.md` не нужно — резолв идёт через состояние,
 *      совпавшее с любым известным синонимом).
 *
 * Если ничего не нашли — `INVALID_INPUT` с понятным сообщением, в которое
 * включаем (a) ожидаемое имя, (b) список aliases, (c) фактические имена
 * колонок в проекте — чтобы оператор увидел, что переименовать.
 */
export function resolveStateWithAliases(
  ref: string,
  aliases: readonly string[],
  states: readonly PlaneState[],
  ctx: { identity: string; projectIdentifier: string },
): string {
  // 1. Прямое совпадение по id (Plane UUID).
  const byId = states.find((s) => s.id === ref);
  if (byId !== undefined) return byId.id;
  // 2. Точное совпадение по имени.
  const byNameExact = states.find((s) => s.name === ref);
  if (byNameExact !== undefined) return byNameExact.id;
  // 3. Case-insensitive по имени.
  const refLower = ref.toLowerCase();
  const byNameCi = states.find((s) => s.name.toLowerCase() === refLower);
  if (byNameCi !== undefined) return byNameCi.id;
  // 4. Алиасы: ref может быть caнonical name, а колонка названа алиасом —
  //    или наоборот. Собираем кандидатов: `ref` + все aliases, нормализуем
  //    к lower-case, и ищем колонку, имя которой попало в этот набор.
  const candidates = new Set<string>([refLower, ...aliases.map((a) => a.toLowerCase())]);
  const byAlias = states.find((s) => candidates.has(s.name.toLowerCase()));
  if (byAlias !== undefined) return byAlias.id;
  // Не нашли — собираем понятное сообщение для оператора.
  const have = states.map((s) => s.name).sort();
  throw new McpError({
    code: 'INVALID_INPUT',
    message:
      `No state matching '${ref}' (aliases: [${aliases.join(', ')}]) ` +
      `in project ${ctx.projectIdentifier} for identity '${ctx.identity}'. ` +
      `Available states: [${have.join(', ')}]. ` +
      'Add the actual column name to `state_aliases` in ' +
      `roles/${ctx.identity}.md and re-run \`make bootstrap\`, or rename the column in Plane.`,
  });
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// Re-export utilities используемые release_issue (избегаем дублирования).
export function claimedLabelName(): string {
  return CLAIMED_LABEL;
}

// Re-export для тестов:
export type { PlaneLabel };
