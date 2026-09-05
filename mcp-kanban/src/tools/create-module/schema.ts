import { z } from 'zod';
import { PLANE_MODULE_STATUSES } from '../../plane-client.js';

export const CreateModuleInput = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(PLANE_MODULE_STATUSES).optional(),
  project: z.string().min(1).optional(),
});
export type CreateModuleInput = z.infer<typeof CreateModuleInput>;
