import { z } from 'zod';

export const ClaimIssueInput = z.object({
  issue_id: z.string().min(1),
  project: z.string().min(1).optional(),
  target_state: z
    .enum(['Analysis', 'Development', 'Security Review', 'Code Review', 'Testing', 'Documenting'])
    .optional(),
});
export type ClaimIssueInput = z.infer<typeof ClaimIssueInput>;

// Default state по identity. Bootstrap manifest хранит то же значение
// (default_state), но дублирование здесь упрощает claim_issue: tool не
// тащит весь manifest в server-context.
export const DEFAULT_STATE_BY_IDENTITY: Record<string, ClaimIssueInput['target_state']> = {
  'analyst-agent': 'Analysis',
  'developer-agent': 'Development',
  'security-auditor-agent': 'Security Review',
  'code-review-agent': 'Code Review',
  'qa-agent': 'Testing',
  'doc-agent': 'Documenting',
};
