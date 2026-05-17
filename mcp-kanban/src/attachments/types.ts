import { McpError } from '../errors.js';

// Унифицированный record для всех вложений (Plane UI / inline-asset из
// комментария / mcp-artifact из агентского bucket'а). Поле `storage` —
// внутреннее: не сериализуется наружу через MCP, нужно только для резолва
// в `read_attachment`. Public-форма для tool-ответов — `PublicAttachment`.

export type AttachmentSource = 'plane_issue' | 'plane_comment_inline' | 'mcp_artifact';

export interface AttachmentStorage {
  bucket: string;
  object_key: string;
}

export interface Attachment {
  id: string;
  source: AttachmentSource;
  filename: string;
  mime_type: string;
  size: number;
  uploaded_at: string;
  uploaded_by?: string;
  comment_id?: string;
  storage: AttachmentStorage;
}

/** Форма, в которой attachment отдаётся через MCP (без `storage`). */
export type PublicAttachment = Omit<Attachment, 'storage'>;

export function toPublic(a: Attachment): PublicAttachment {
  const { storage: _storage, ...rest } = a;
  void _storage;
  return rest;
}

/** Префиксы id, по которым резолвер понимает, в какой источник идти. */
export const ATTACHMENT_ID_PREFIX: Record<AttachmentSource, string> = {
  plane_issue: 'pi_',
  plane_comment_inline: 'pci_',
  mcp_artifact: 'mca_',
};

export interface ParsedAttachmentId {
  source: AttachmentSource;
  /**
   * Для `pi_` — Plane attachment UUID; для `pci_` —
   * `<comment_uuid>_<sha1[:12]>`; для `mca_` — `sha1(object_key)[:16]`.
   */
  payload: string;
}

/**
 * Парс public-id вложения. Невалидный формат — `INVALID_INPUT`.
 *
 * Для `pci_*` payload должен иметь форму `<uuid>_<12hex>`; для `mca_*` —
 * ровно 16 hex-символов. Эти ограничения не критичны (резолв сам отсечёт
 * непадежные), но дают рано-failing валидацию на уровне zod-input.
 */
export function parseAttachmentId(id: string): ParsedAttachmentId {
  if (id.startsWith(ATTACHMENT_ID_PREFIX.plane_issue)) {
    const payload = id.slice(ATTACHMENT_ID_PREFIX.plane_issue.length);
    if (payload.length === 0) {
      throw new McpError({ code: 'INVALID_INPUT', message: `Empty payload in attachment id: ${id}` });
    }
    return { source: 'plane_issue', payload };
  }
  if (id.startsWith(ATTACHMENT_ID_PREFIX.plane_comment_inline)) {
    const payload = id.slice(ATTACHMENT_ID_PREFIX.plane_comment_inline.length);
    if (!/^[0-9a-f-]+_[0-9a-f]{12}$/i.test(payload)) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `Malformed plane_comment_inline id: ${id} (expected pci_<comment-uuid>_<12hex>)`,
      });
    }
    return { source: 'plane_comment_inline', payload };
  }
  if (id.startsWith(ATTACHMENT_ID_PREFIX.mcp_artifact)) {
    const payload = id.slice(ATTACHMENT_ID_PREFIX.mcp_artifact.length);
    if (!/^[0-9a-f]{16}$/i.test(payload)) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `Malformed mcp_artifact id: ${id} (expected mca_<16hex>)`,
      });
    }
    return { source: 'mcp_artifact', payload };
  }
  throw new McpError({
    code: 'INVALID_INPUT',
    message: `Unknown attachment id prefix: ${id} (expected pi_/pci_/mca_)`,
  });
}

/** Стейбл-id для mcp_artifact: sha1(object_key)[:16] — короткий и
 *  обратимо находится через listObjectsV2 + hash compare. */
export function mcaIdFromObjectKey(objectKey: string, sha1: (s: string) => string): string {
  return `${ATTACHMENT_ID_PREFIX.mcp_artifact}${sha1(objectKey).slice(0, 16)}`;
}

/** Стейбл-id для plane_comment_inline: pci_<comment_uuid>_<sha1(url)[:12]>. */
export function pciIdFromAsset(commentId: string, assetUrl: string, sha1: (s: string) => string): string {
  return `${ATTACHMENT_ID_PREFIX.plane_comment_inline}${commentId}_${sha1(assetUrl).slice(0, 12)}`;
}
