import { z } from 'zod';

export const AttachFileInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(127),
  size: z.number().int().positive(),
  // Размерный лимит direct-аплоада больше НЕ хардкодится здесь: транспортный
  // потолок задаёт Fastify `bodyLimit` (MCP_BODY_LIMIT_BYTES), а точный лимит
  // по decoded-байтам — handler из config (MCP_ATTACH_MAX_BYTES). SLONK-31.
  content_base64: z.string().optional(),
  /**
   * Если передан `complete: true` — фаза «attach-complete»: MCP проверяет
   * аплоад и регистрирует вложение в Plane после успешного PUT. Иначе —
   * выдаёт presigned PUT URL.
   */
  complete: z.boolean().optional(),
  object_key: z.string().optional(),
  /** Необязательная заметка, добавляемая в комментарий-аннотацию на фазе
   *  complete (например, «лог прогона тестов»). */
  note: z.string().min(1).max(2000).optional(),
});
export type AttachFileInput = z.infer<typeof AttachFileInput>;
