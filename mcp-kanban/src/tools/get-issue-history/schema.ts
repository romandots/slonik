import { z } from 'zod';

export const GetIssueHistoryInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
});
export type GetIssueHistoryInput = z.infer<typeof GetIssueHistoryInput>;
