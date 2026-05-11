import { z } from 'zod';

export const ReleaseIssueInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
});
export type ReleaseIssueInput = z.infer<typeof ReleaseIssueInput>;
