import { z } from 'zod';

export const AddIssuesToModuleInput = z.object({
  module: z.string().min(1),
  issue_ids: z.array(z.string().min(1)).min(1).max(100),
  project: z.string().min(1).optional(),
});
export type AddIssuesToModuleInput = z.infer<typeof AddIssuesToModuleInput>;
