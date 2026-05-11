import { z } from 'zod';

export const UpdateIssueInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
});
export type UpdateIssueInput = z.infer<typeof UpdateIssueInput>;
