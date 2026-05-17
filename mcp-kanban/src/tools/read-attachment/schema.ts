import { z } from 'zod';

export const ReadAttachmentInput = z.object({
  issue_id: z.string().min(1),
  attachment_id: z.string().regex(/^(pi|pci|mca)_/),
  project: z.string().min(1).optional(),
});
export type ReadAttachmentInput = z.infer<typeof ReadAttachmentInput>;
