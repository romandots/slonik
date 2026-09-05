import { z } from 'zod';
import type { PlaneRelationType } from '../../plane-client.js';

/**
 * Типы связей, которые принимает публичный API Plane v1.3.0
 * (`POST work-items/<iid>/relations/`), плюс исторический алиас
 * `duplicate_of` — он ушёл в контракт вместе с SLONK-33 и остаётся
 * рабочим, чтобы не ломать уже обученных агентов.
 *
 * Направление: тип описывает роль ДРУГОЙ задачи относительно текущей.
 * `blocked_by` — текущая заблокирована указанной; `blocking` — текущая
 * блокирует указанную.
 */
export const RELATION_TYPES = [
  'relates_to',
  'duplicate',
  'duplicate_of',
  'blocked_by',
  'blocking',
  'start_before',
  'start_after',
  'finish_before',
  'finish_after',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Алиасы MCP-контракта → словарь Plane. */
export function toPlaneRelationType(type: RelationType): PlaneRelationType {
  return type === 'duplicate_of' ? 'duplicate' : type;
}

export const IssueRelationsInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  action: z.enum(['add', 'remove', 'list']),
  relation_type: z.enum(RELATION_TYPES).optional(),
  related_issue_id: z.string().min(1).optional(),
  related_project: z.string().min(1).optional(),
});
export type IssueRelationsInput = z.infer<typeof IssueRelationsInput>;
