import { z } from 'zod';

export const CommentIssueInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  comment: z.string().min(1),
  /**
   * Опциональный токен для клиента: позволяет MCP отбрасывать дубликаты
   * (см. SPEC §6.5). В аудите хранится в `input_hash`.
   */
  client_dedup_key: z.string().min(1).optional(),
});
export type CommentIssueInput = z.infer<typeof CommentIssueInput>;
