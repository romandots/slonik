// Перечень agent-identities, известных MCP-серверу. Источник правды — здесь;
// в Phase 3 будет вырезан в bootstrap/manifest.yaml. До тех пор список
// захардкожен в одном месте, чтобы избежать рассинхронизации между
// валидацией X-Agent-Identity и tool'ами.

export const AGENT_IDENTITIES = [
  'analyst-agent',
  'developer-agent',
  'security-auditor-agent',
  'code-review-agent',
  'qa-agent',
  'doc-agent',
] as const;

export type AgentIdentity = (typeof AGENT_IDENTITIES)[number];

const SET: ReadonlySet<string> = new Set(AGENT_IDENTITIES);

export function isAgentIdentity(value: string): value is AgentIdentity {
  return SET.has(value);
}
