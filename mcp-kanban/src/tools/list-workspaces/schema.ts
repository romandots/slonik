import { z } from 'zod';

export const ListWorkspacesInput = z.object({});
export type ListWorkspacesInput = z.infer<typeof ListWorkspacesInput>;
