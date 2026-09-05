import { z } from 'zod';

export const ListIssuesInput = z.object({
  project: z.string().min(1).optional(),
  state: z.union([z.string(), z.array(z.string())]).optional(),
  label: z.union([z.string(), z.array(z.string())]).optional(),
  assignee: z.union([z.string(), z.array(z.string())]).optional(),
  priority: z.union([z.string(), z.array(z.string())]).optional(),
  cycle: z.string().optional(),
  module: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  /** Курсор из `next_cursor` предыдущего вызова (SLONK-37). */
  cursor: z.string().min(1).optional(),
});
export type ListIssuesInput = z.infer<typeof ListIssuesInput>;
