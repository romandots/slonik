import { z } from 'zod';

export const TransitionIssueInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  state: z.string().min(1),
  comment: z.string().optional(),
});
export type TransitionIssueInput = z.infer<typeof TransitionIssueInput>;
