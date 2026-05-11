import { z } from 'zod';

export const AttachFileInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(127),
  size: z.number().int().positive(),
  /**
   * Если передан `complete: true` — фаза «attach-complete»: MCP записывает
   * метаданные в Plane после успешного PUT. Иначе — выдаёт presigned URL.
   */
  complete: z.boolean().optional(),
  object_key: z.string().optional(),
});
export type AttachFileInput = z.infer<typeof AttachFileInput>;
