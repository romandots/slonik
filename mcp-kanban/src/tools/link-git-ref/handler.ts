import type { PlaneClient, PlaneIssue, PlaneLabel } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { GitRefsIndex } from '../../git-refs.js';
import { McpError } from '../../errors.js';
import {
  parseDescription,
  preserveCorruptDescription,
  serializeDescription,
  upsertGitRef,
  type GitRef,
  type MetaBlock,
} from '../../meta-block.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import type { LinkGitRefInput } from './schema.js';

const NEEDS_HUMAN_LABEL = 'needs-human';

export interface LinkGitRefResult extends IssueSummary {
  meta: MetaBlock;
  meta_was_corrupt: boolean;
  meta_recovered: boolean;
}

export async function linkGitRef(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  gitRefs: GitRefsIndex;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  input: LinkGitRefInput;
}): Promise<LinkGitRefResult> {
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

  const issue = await deps.plane.getIssue(deps.workspace, project.id, issueId);
  if (issue === undefined) {
    throw new McpError({ code: 'NOT_FOUND', message: `Issue ${issueId} not found` });
  }

  const [states, labels] = await Promise.all([
    deps.plane.listStates(deps.workspace, project.id),
    deps.plane.listLabels(deps.workspace, project.id),
  ]);

  const rawDescription = issue.description ?? '';
  const parsedDesc = parseDescription(rawDescription);

  const newRef: GitRef = {
    url: deps.input.repo_url,
    ...(deps.input.branch !== undefined ? { branch: deps.input.branch } : {}),
    ...(deps.input.pr_url !== undefined ? { pr: deps.input.pr_url } : {}),
    commits: deps.input.commit !== undefined ? [deps.input.commit] : [],
  };

  let nextBody: string;
  let nextMeta: MetaBlock;
  let metaWasCorrupt = false;
  let metaRecovered = false;

  if (parsedDesc.corrupt) {
    // Не разрушаем — пакуем сломанный блок и пишем свежий рядом, далее
    // помечаем `needs-human` (см. ниже).
    metaWasCorrupt = true;
    const preserved = preserveCorruptDescription(rawDescription);
    if (preserved.recovered) {
      nextBody = preserved.body.length > 0
        ? `${preserved.body}\n\n${preserved.quoted}`
        : preserved.quoted;
      metaRecovered = true;
    } else {
      nextBody = parsedDesc.body;
    }
    nextMeta = upsertGitRef({ repos: [] }, newRef);
  } else {
    nextBody = parsedDesc.body;
    nextMeta = upsertGitRef(parsedDesc.meta, newRef);
  }

  const newDescription = serializeDescription(nextBody, nextMeta);
  const labelPatch = metaWasCorrupt ? ensureLabel(issue.labels, labels, NEEDS_HUMAN_LABEL) : undefined;

  // Идемпотентность: если описание не поменялось и labels не нужны —
  // не дёргаем Plane (но индекс всё равно upsert'нем, на случай если
  // он расходится с meta).
  const descriptionChanged = newDescription !== rawDescription;
  const labelsChanged = labelPatch !== undefined;

  let updated: PlaneIssue = issue;
  if (descriptionChanged || labelsChanged) {
    const patch: Parameters<PlaneClient['updateIssue']>[3] = {};
    if (descriptionChanged) patch.description = newDescription;
    if (labelsChanged) patch.labels = labelPatch;
    updated = await deps.plane.updateIssue(deps.workspace, project.id, issueId, patch);
  }

  const issueKey =
    issue.sequence_id !== undefined ? `${project.identifier}-${issue.sequence_id}` : issueId;
  deps.gitRefs.upsert({
    workspace: deps.workspace,
    project_identifier: project.identifier,
    issue_id: issueId,
    issue_key: issueKey,
    repo_url: deps.input.repo_url,
    ...(deps.input.branch !== undefined ? { branch: deps.input.branch } : {}),
    ...(deps.input.pr_url !== undefined ? { pr_url: deps.input.pr_url } : {}),
    ...(deps.input.commit !== undefined ? { commit_sha: deps.input.commit } : {}),
  });

  deps.cache.clear();
  const summary = summarise(updated, states, labels, project.identifier);
  return {
    ...summary,
    meta: nextMeta,
    meta_was_corrupt: metaWasCorrupt,
    meta_recovered: metaRecovered,
  };
}

function ensureLabel(currentLabelIds: string[], allLabels: PlaneLabel[], wanted: string): string[] | undefined {
  const targetLabel = allLabels.find((l) => l.name === wanted);
  if (targetLabel === undefined) {
    // Bootstrap должен был его создать; без него Plane заглотит null silently.
    // Пропускаем, без жёсткой ошибки — link_git_ref важнее, чем лейбл.
    return undefined;
  }
  if (currentLabelIds.includes(targetLabel.id)) return undefined;
  return [...currentLabelIds, targetLabel.id];
}
