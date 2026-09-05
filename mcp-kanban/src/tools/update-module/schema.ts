import { z } from 'zod';
import { PLANE_MODULE_STATUSES } from '../../plane-client.js';

export const UpdateModuleInput = z.object({
  module: z.string().min(1),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(PLANE_MODULE_STATUSES).optional(),
  project: z.string().min(1).optional(),
});
export type UpdateModuleInput = z.infer<typeof UpdateModuleInput>;
