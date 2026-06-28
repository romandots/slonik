import { z } from 'zod';

export const RELATION_TYPES = ['relates_to', 'duplicate_of', 'blocked_by', 'blocking'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const IssueRelationsInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  action: z.enum(['add', 'remove', 'list']),
  relation_type: z.enum(RELATION_TYPES).optional(),
  related_issue_id: z.string().min(1).optional(),
  related_project: z.string().min(1).optional(),
});
export type IssueRelationsInput = z.infer<typeof IssueRelationsInput>;
