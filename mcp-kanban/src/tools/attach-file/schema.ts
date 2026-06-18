import { z } from 'zod';

const DIRECT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const DIRECT_UPLOAD_MAX_BASE64_CHARS = Math.ceil(DIRECT_UPLOAD_MAX_BYTES / 3) * 4;

export const AttachFileInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(127),
  size: z.number().int().positive(),
  content_base64: z.string().max(DIRECT_UPLOAD_MAX_BASE64_CHARS).optional(),
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
