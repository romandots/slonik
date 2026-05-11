import { z } from 'zod';

export const BlockIssueInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  reason: z.string().min(1),
});
export type BlockIssueInput = z.infer<typeof BlockIssueInput>;
