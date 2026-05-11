import { z } from 'zod';

export const ListCyclesInput = z.object({
  project: z.string().min(1).optional(),
});
export type ListCyclesInput = z.infer<typeof ListCyclesInput>;
