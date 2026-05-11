import { z } from 'zod';

export const GetIssueInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
});
export type GetIssueInput = z.infer<typeof GetIssueInput>;

// Plane sequence-id записывается как `SLONK-123`; полноценный uuid — тоже
// допустим. Парсер ниже определяет тип входа.
export interface ResolvedIssueRef {
  kind: 'uuid' | 'sequence';
  uuid?: string;
  identifier?: string;
  sequence?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^([A-Z][A-Z0-9]{0,11})-(\d+)$/;

export function parseIssueRef(ref: string): ResolvedIssueRef {
  if (UUID_RE.test(ref)) {
    return { kind: 'uuid', uuid: ref };
  }
  const m = KEY_RE.exec(ref);
  if (m !== null) {
    return { kind: 'sequence', identifier: m[1]!, sequence: Number.parseInt(m[2]!, 10) };
  }
  // Fallback: считаем uuid-подобной строкой.
  return { kind: 'uuid', uuid: ref };
}
