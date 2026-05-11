import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { AgentIdentity } from '../identity.js';
import { whoAmI } from './who-am-i/handler.js';

export interface ToolContext {
  config: Config;
  serverVersion: string;
  /**
   * Возвращает identity для текущего вызова. В HTTP-транспорте берётся из
   * X-Agent-Identity через auth.ts; в тестах задаётся напрямую.
   */
  resolveIdentity: () => AgentIdentity;
}

/** Зарегистрированные tools (имена) — используется /mcp/tools для debug. */
export const REGISTERED_TOOL_NAMES = ['who_am_i'] as const;
export type RegisteredToolName = (typeof REGISTERED_TOOL_NAMES)[number];

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'who_am_i',
    {
      description: 'Return current agent identity and server metadata.',
      inputSchema: {},
    },
    () => {
      const result = whoAmI({
        identity: ctx.resolveIdentity(),
        agentMode: ctx.config.MCP_AGENT_IDENTITY_MODE,
        serverVersion: ctx.serverVersion,
        defaultWorkspace: ctx.config.MCP_DEFAULT_WORKSPACE,
        defaultProject: ctx.config.MCP_DEFAULT_PROJECT,
      });
      // MCP SDK ожидает у structuredContent индекс-сигнатуру; кастуем
      // через Record<string, unknown> — поля совпадают, типы выводятся.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
