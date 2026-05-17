import { z } from 'zod';

// SLONK-6: `target_state` теперь произвольная строка (не enum) — имя
// колонки канбана может быть локализовано или переименовано пользователем
// руками в Plane UI. Резолв в `state_id` происходит в handler'е через
// `resolveStateRef` + `state_aliases` из IdentityStore.
//
// Дефолтное состояние для роли тоже больше не лежит здесь: оно
// загружается из `IdentityStore.default_state` (наполняется `make
// bootstrap` из `roles/*.md`). Это позволяет добавлять кастомные роли
// без правки кода.
export const ClaimIssueInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  target_state: z.string().min(1).optional(),
});
export type ClaimIssueInput = z.infer<typeof ClaimIssueInput>;
