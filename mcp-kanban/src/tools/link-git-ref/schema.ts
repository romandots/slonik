import { z } from 'zod';

// Контракт link_git_ref (SPEC §6.3). Хотя бы один из branch/pr_url/commit
// должен быть задан — без полезной нагрузки запись бессмысленна.
const Sha = z.string().regex(/^[0-9a-f]{7,40}$/, 'expected commit sha (7..40 hex chars)');

// Шейп — отдельным объектом, чтобы MCP SDK мог использовать `.shape`
// для построения JSON Schema. Refine — только для runtime-валидации.
export const LinkGitRefShape = {
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  repo_url: z.string().url(),
  branch: z.string().min(1).optional(),
  pr_url: z.string().url().optional(),
  commit: Sha.optional(),
} as const;

export const LinkGitRefInput = z.object(LinkGitRefShape).refine(
  (v) => v.branch !== undefined || v.pr_url !== undefined || v.commit !== undefined,
  { message: 'at least one of branch, pr_url, commit is required' },
);
export type LinkGitRefInput = z.infer<typeof LinkGitRefInput>;
