import { z } from 'zod';

export const ListModulesInput = z.object({
  project: z.string().min(1).optional(),
});
export type ListModulesInput = z.infer<typeof ListModulesInput>;
