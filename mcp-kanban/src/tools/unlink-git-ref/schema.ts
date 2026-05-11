import { z } from 'zod';

const Sha = z.string().regex(/^[0-9a-f]{7,40}$/, 'expected commit sha (7..40 hex chars)');

export const UnlinkGitRefInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  repo_url: z.string().url(),
  /**
   * Если задан — удаляется только этот коммит из repo-записи. Если опущен —
   * удаляется вся запись по repo_url (включая branch/pr).
   */
  commit: Sha.optional(),
});
export type UnlinkGitRefInput = z.infer<typeof UnlinkGitRefInput>;
