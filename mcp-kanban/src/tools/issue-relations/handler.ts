import type { PlaneClient, PlaneIssueRelation } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import type { IssueRelationsInput, RelationType } from './schema.js';

export interface RelationEntry {
  id: string;
  relation_type: RelationType;
  issue_id: string;
  related_issue_id: string;
}

export interface IssueRelationsResult {
  ok: true;
  action: 'list' | 'add' | 'remove';
  issue_id: string;
  relations: RelationEntry[];
  /** Populated on add */
  created?: RelationEntry;
  /** Populated on remove */
  removed_id?: string;
}

function toEntry(r: PlaneIssueRelation): RelationEntry {
  return {
    id: r.id,
    relation_type: r.relation_type as RelationType,
    issue_id: r.issue,
    related_issue_id: r.related_issue,
  };
}

export async function issueRelations(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  input: IssueRelationsInput;
}): Promise<IssueRelationsResult> {
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
    const raw = await deps.plane.listIssueRelations(deps.workspace, project.id, issueId);
    return {
      ok: true,
      action: 'list',
      issue_id: issueId,
      relations: raw.map(toEntry),
    };
  }

  if (deps.input.action === 'add') {
    if (deps.input.relation_type === undefined) {
      throw new McpError({ code: 'INVALID_INPUT', message: 'relation_type is required for action=add' });
    }
    if (deps.input.related_issue_id === undefined) {
      throw new McpError({ code: 'INVALID_INPUT', message: 'related_issue_id is required for action=add' });
    }

    const relatedParsed = parseIssueRef(deps.input.related_issue_id);
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
    const relatedIssueId = await resolveIssueId(deps.plane, deps.workspace, relatedProject, relatedParsed);

    const created = await deps.plane.createIssueRelation(deps.workspace, project.id, issueId, {
      relation_type: deps.input.relation_type,
      related_issue: relatedIssueId,
    });
    deps.cache.clear();

    const raw = await deps.plane.listIssueRelations(deps.workspace, project.id, issueId);
    return {
      ok: true,
      action: 'add',
      issue_id: issueId,
      relations: raw.map(toEntry),
      created: toEntry(created),
    };
  }

  // action === 'remove'
  if (deps.input.relation_type === undefined) {
    throw new McpError({ code: 'INVALID_INPUT', message: 'relation_type is required for action=remove' });
  }
  if (deps.input.related_issue_id === undefined) {
    throw new McpError({ code: 'INVALID_INPUT', message: 'related_issue_id is required for action=remove' });
  }

  const relatedParsed = parseIssueRef(deps.input.related_issue_id);
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
  const relatedIssueId = await resolveIssueId(deps.plane, deps.workspace, relatedProject, relatedParsed);

  const existing = await deps.plane.listIssueRelations(deps.workspace, project.id, issueId);
  const match = existing.find(
    (r) => r.relation_type === deps.input.relation_type && r.related_issue === relatedIssueId,
  );
  if (match === undefined) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `Relation ${deps.input.relation_type} to ${relatedIssueId} not found on issue ${issueId}`,
    });
  }

  await deps.plane.deleteIssueRelation(deps.workspace, project.id, issueId, match.id);
  deps.cache.clear();

  const raw = await deps.plane.listIssueRelations(deps.workspace, project.id, issueId);
  return {
    ok: true,
    action: 'remove',
    issue_id: issueId,
    relations: raw.map(toEntry),
    removed_id: match.id,
  };
}
