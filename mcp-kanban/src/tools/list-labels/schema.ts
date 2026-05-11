import { z } from 'zod';

export const ListLabelsInput = z.object({
  project: z.string().min(1).optional(),
});
export type ListLabelsInput = z.infer<typeof ListLabelsInput>;
