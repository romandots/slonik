import { z } from 'zod';

/**
 * `embed_image` (SLONK-32): встраивает растровую картинку в описание или
 * комментарий задачи как нативный Plane-asset (`<image-component>`), чтобы её
 * видел человек в Plane UI. Лимит размера — из config (MCP_ATTACH_MAX_BYTES);
 * MIME-allowlist (растр, без svg) форсируется в handler'е.
 */
export const EmbedImageInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  /** Куда встроить: в описание задачи (read-modify-write) или новым комментарием. */
  target: z.enum(['description', 'comment']).default('description'),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(127),
  size: z.number().int().positive(),
  /** Содержимое картинки, base64 (standard). */
  content_base64: z.string().min(1),
  /** Необязательная подпись под картинкой (экранируется). */
  caption: z.string().min(1).max(2000).optional(),
});
export type EmbedImageInput = z.infer<typeof EmbedImageInput>;
