import { z } from 'zod';

export const CreateIssueInput = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  project: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
});
export type CreateIssueInput = z.infer<typeof CreateIssueInput>;
