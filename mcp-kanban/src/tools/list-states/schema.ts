import { z } from 'zod';

export const ListStatesInput = z.object({
  project: z.string().min(1).optional(),
});
export type ListStatesInput = z.infer<typeof ListStatesInput>;
