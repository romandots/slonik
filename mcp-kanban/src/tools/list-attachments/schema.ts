import { z } from 'zod';

export const ListAttachmentsInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  source: z
    .enum(['plane_issue', 'plane_comment_inline', 'mcp_artifact', 'all'])
    .default('all'),
  comment_id: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListAttachmentsInput = z.infer<typeof ListAttachmentsInput>;
