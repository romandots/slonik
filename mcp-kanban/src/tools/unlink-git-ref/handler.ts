import type { PlaneClient, PlaneIssue } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { GitRefsIndex } from '../../git-refs.js';
import { McpError } from '../../errors.js';
import {
  parseDescription,
  removeGitRef,
  serializeDescription,
  type MetaBlock,
} from '../../meta-block.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';
import type { UnlinkGitRefInput } from './schema.js';

export interface UnlinkGitRefResult extends IssueSummary {
  meta: MetaBlock;
  removed: number;
  meta_was_corrupt: boolean;
}

export async function unlinkGitRef(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  gitRefs: GitRefsIndex;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  input: UnlinkGitRefInput;
}): Promise<UnlinkGitRefResult> {
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

  // При повреждённом блоке мы не можем безопасно удалить нужный ref —
  // блок не парсится. SPEC §5.6 говорит recovery делать в link_git_ref;
  // в unlink — отдаём CONFLICT, чтобы агент сам решил, что делать.
  if (parsedDesc.corrupt) {
    throw new McpError({
      code: 'CONFLICT',
      message: 'meta block is corrupt; run link_git_ref first to recover, then retry',
    });
  }

  const beforeCount = countRefsForRepo(parsedDesc.meta, deps.input.repo_url, deps.input.commit);
  const nextMeta = removeGitRef(parsedDesc.meta, {
    url: deps.input.repo_url,
    ...(deps.input.commit !== undefined ? { commit: deps.input.commit } : {}),
  });
  const afterCount = countRefsForRepo(nextMeta, deps.input.repo_url, deps.input.commit);
  const removedFromMeta = Math.max(0, beforeCount - afterCount);

  const newDescription = serializeDescription(parsedDesc.body, nextMeta);

  let updated: PlaneIssue = issue;
  if (newDescription !== rawDescription) {
    updated = await deps.plane.updateIssue(deps.workspace, project.id, issueId, {
      description: newDescription,
    });
  }

  const removedFromIndex = deps.gitRefs.remove({
    issue_id: issueId,
    repo_url: deps.input.repo_url,
    ...(deps.input.commit !== undefined ? { commit_sha: deps.input.commit } : {}),
  });

  deps.cache.clear();
  const summary = summarise(updated, states, labels, project.identifier);
  return {
    ...summary,
    meta: nextMeta,
    removed: Math.max(removedFromMeta, removedFromIndex),
    meta_was_corrupt: false,
  };
}

function countRefsForRepo(meta: MetaBlock, repoUrl: string, commit?: string): number {
  const repo = meta.repos.find((r) => r.url === repoUrl);
  if (repo === undefined) return 0;
  if (commit === undefined) return 1;
  return repo.commits.includes(commit) ? 1 : 0;
}
