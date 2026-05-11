import type { GitRefsIndex, GitRefRow } from '../../git-refs.js';
import { rowToPublic } from '../../git-refs.js';
import type { FindIssuesByGitRefInput } from './schema.js';

export interface FindIssuesByGitRefResult {
  results: Array<Omit<GitRefRow, 'commit_sha'> & { commit_sha: string | null }>;
  count: number;
}

export function findIssuesByGitRef(deps: {
  gitRefs: GitRefsIndex;
  input: FindIssuesByGitRefInput;
}): FindIssuesByGitRefResult {
  const rows = deps.gitRefs.find({
    ...(deps.input.repo_url !== undefined ? { repo_url: deps.input.repo_url } : {}),
    ...(deps.input.branch !== undefined ? { branch: deps.input.branch } : {}),
    ...(deps.input.pr_url !== undefined ? { pr_url: deps.input.pr_url } : {}),
    ...(deps.input.commit !== undefined ? { commit_sha: deps.input.commit } : {}),
    ...(deps.input.limit !== undefined ? { limit: deps.input.limit } : {}),
  });
  return { results: rows.map(rowToPublic), count: rows.length };
}
