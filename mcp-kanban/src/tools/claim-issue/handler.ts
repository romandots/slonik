import type { PlaneClient, PlaneIssue, PlaneLabel } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import type { AuditLog } from '../../audit.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { resolveStateRef } from '../create-issue/handler.js';
import { formatComment } from '../comment-issue/handler.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import { type ClaimIssueInput, DEFAULT_STATE_BY_IDENTITY } from './schema.js';

const CLAIMED_LABEL = 'agent-claimed';

export interface ClaimIssueResult extends IssueSummary {
  claimed_by: AgentIdentity;
  trace_id: string;
}

export async function claimIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  audit: AuditLog;
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
    const targetStateName = deps.input.target_state ?? DEFAULT_STATE_BY_IDENTITY[deps.identity];
    if (targetStateName === undefined) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `No default state mapped for identity ${deps.identity}; pass target_state explicitly`,
      });
    }
    const stateId = resolveStateRef(targetStateName, states);

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

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// Re-export utilities используемые release_issue (избегаем дублирования).
export function claimedLabelName(): string {
  return CLAIMED_LABEL;
}

// Re-export для тестов:
export type { PlaneLabel };
