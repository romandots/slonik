import { z } from 'zod';

const Sha = z.string().regex(/^[0-9a-f]{7,40}$/, 'expected commit sha (7..40 hex chars)');

export const FindIssuesByGitRefShape = {
  repo_url: z.string().url().optional(),
  branch: z.string().min(1).optional(),
  pr_url: z.string().url().optional(),
  commit: Sha.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
} as const;

export const FindIssuesByGitRefInput = z.object(FindIssuesByGitRefShape).refine(
  (v) =>
    v.repo_url !== undefined ||
    v.branch !== undefined ||
    v.pr_url !== undefined ||
    v.commit !== undefined,
  { message: 'at least one of repo_url, branch, pr_url, commit is required' },
);
export type FindIssuesByGitRefInput = z.infer<typeof FindIssuesByGitRefInput>;
