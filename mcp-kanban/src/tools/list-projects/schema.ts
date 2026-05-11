import { z } from 'zod';

export const ListProjectsInput = z.object({
  workspace: z.string().min(1).optional(),
});
export type ListProjectsInput = z.infer<typeof ListProjectsInput>;
