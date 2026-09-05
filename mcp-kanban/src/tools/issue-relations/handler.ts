import type { PlaneClient, PlaneIssueRelationGroups, PlaneRelationType } from '../../plane-client.js';
import { PLANE_RELATION_TYPES } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { McpError, PlaneError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import type { IssueRelationsInput, RelationType } from './schema.js';
import { toPlaneRelationType } from './schema.js';

/**
 * Сколько связанных задач разрешено дорезолвить до человекочитаемого
 * ключа (`SLONK-7`). Каждый резолв — отдельный GET к Plane, поэтому у
 * задач с десятками связей ключи проставляются только для первых
 * `MAX_KEY_LOOKUPS`, остальные остаются UUID'ами.
 */
const MAX_KEY_LOOKUPS = 25;

export interface RelationEntry {
  relation_type: PlaneRelationType;
  related_issue_id: string;
  /** `SLONK-7`, если задача лежит в том же проекте и её удалось прочитать. */
  related_issue_key?: string;
  related_issue_name?: string;
}

export interface IssueRelationsResult {
  ok: true;
  action: 'list' | 'add' | 'remove';
  issue_id: string;
  relations: RelationEntry[];
  /** Populated on add */
  created?: RelationEntry;
}

/**
 * Разворачивает сгруппированный ответ Plane (`{blocked_by: [uuid], ...}`)
 * в плоский список записей. Чистая функция — вся сеть снаружи.
 */
export function flattenRelationGroups(groups: PlaneIssueRelationGroups): RelationEntry[] {
  const out: RelationEntry[] = [];
  for (const relation_type of PLANE_RELATION_TYPES) {
    for (const related_issue_id of groups[relation_type]) {
      out.push({ relation_type, related_issue_id });
    }
  }
  return out;
}

/**
 * Best-effort обогащение: UUID → `IDENT-seq` + имя. Задачи из других
 * проектов через публичный API по UUID не адресуются, поэтому такие
 * записи остаются без ключа — это не ошибка.
 */
async function withIssueKeys(
  plane: PlaneClient,
  workspace: string,
  project: { id: string; identifier: string },
  entries: RelationEntry[],
): Promise<RelationEntry[]> {
  const unique = [...new Set(entries.map((e) => e.related_issue_id))].slice(0, MAX_KEY_LOOKUPS);
  const known = new Map<string, { key: string; name: string }>();
  await Promise.all(
    unique.map(async (issueId) => {
      const issue = await plane.getIssue(workspace, project.id, issueId).catch(() => undefined);
      if (issue === undefined || issue.sequence_id === undefined) return;
      known.set(issueId, {
        key: `${project.identifier}-${issue.sequence_id}`,
        name: issue.name,
      });
    }),
  );
  return entries.map((e) => {
    const hit = known.get(e.related_issue_id);
    return hit === undefined
      ? e
      : { ...e, related_issue_key: hit.key, related_issue_name: hit.name };
  });
}

/**
 * Публичный API Plane отдаёт 404 на `relations/`, если инсталляция
 * старше v1.3.0. Сырой NOT_FOUND в этом случае вводит агента в
 * заблуждение («задачи нет»), поэтому переводим его в UNSUPPORTED.
 */
function mapRelationsUnavailable(err: unknown): never {
  if (err instanceof PlaneError && err.planeStatus === 404) {
    throw new McpError({
      code: 'UNSUPPORTED',
      message:
        'Plane REST API does not expose work-item relations at this version. ' +
        'Requires Plane v1.3.0+ (GET/POST work-items/<id>/relations/).',
      cause: err,
    });
  }
  throw err;
}

async function readRelations(
  plane: PlaneClient,
  workspace: string,
  projectId: string,
  issueId: string,
): Promise<PlaneIssueRelationGroups> {
  try {
    return await plane.listIssueRelations(workspace, projectId, issueId);
  } catch (err) {
    return mapRelationsUnavailable(err);
  }
}

function requireRelationArgs(input: IssueRelationsInput): {
  relationType: RelationType;
  relatedIssueRef: string;
} {
  if (input.relation_type === undefined) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: `relation_type is required for action=${input.action}`,
    });
  }
  if (input.related_issue_id === undefined) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: `related_issue_id is required for action=${input.action}`,
    });
  }
  return { relationType: input.relation_type, relatedIssueRef: input.related_issue_id };
}

export async function issueRelations(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  input: IssueRelationsInput;
}): Promise<IssueRelationsResult> {
  // action=remove отбиваем до любых сетевых вызовов: удалять нечем.
  if (deps.input.action === 'remove') {
    throw new McpError({
      code: 'UNSUPPORTED',
      message:
        'Plane public REST API v1.3.0 exposes only GET/POST on work-item relations — ' +
        'there is no delete endpoint, so issue_relations cannot remove a relation. ' +
        'Remove it in the Plane UI (work item → Relations → ×).',
    });
  }

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
  });
  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsed);

  if (deps.input.action === 'list') {
    const groups = await readRelations(deps.plane, deps.workspace, project.id, issueId);
    return {
      ok: true,
      action: 'list',
      issue_id: issueId,
      relations: await withIssueKeys(
        deps.plane,
        deps.workspace,
        project,
        flattenRelationGroups(groups),
      ),
    };
  }

  const { relationType, relatedIssueRef } = requireRelationArgs(deps.input);
  const relatedParsed = parseIssueRef(relatedIssueRef);
  const relatedProject = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.related_project !== undefined
      ? { projectRef: deps.input.related_project }
      : relatedParsed.kind === 'sequence' && relatedParsed.identifier !== undefined
        ? { projectRef: relatedParsed.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });
  const relatedIssueId = await resolveIssueId(
    deps.plane,
    deps.workspace,
    relatedProject,
    relatedParsed,
  );

  const planeRelation = toPlaneRelationType(relationType);
  try {
    await deps.plane.createIssueRelations(deps.workspace, project.id, issueId, {
      relation_type: planeRelation,
      issues: [relatedIssueId],
    });
  } catch (err) {
    mapRelationsUnavailable(err);
  }
  deps.cache.clear();

  // Читаем связи обратно: POST отдаёт «другую сторону» связи в своём
  // формате, а агенту нужна та же картина, что и в action=list.
  const groups = await readRelations(deps.plane, deps.workspace, project.id, issueId);
  const relations = await withIssueKeys(
    deps.plane,
    deps.workspace,
    project,
    flattenRelationGroups(groups),
  );
  const created = relations.find(
    (r) => r.relation_type === planeRelation && r.related_issue_id === relatedIssueId,
  );

  return {
    ok: true,
    action: 'add',
    issue_id: issueId,
    relations,
    ...(created !== undefined
      ? { created }
      : { created: { relation_type: planeRelation, related_issue_id: relatedIssueId } }),
  };
}
