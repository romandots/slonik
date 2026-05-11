import { z } from 'zod';

export const SearchIssuesInput = z.object({
  query: z.string().min(1),
  project: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type SearchIssuesInput = z.infer<typeof SearchIssuesInput>;
