import type { AgentIdentity } from '../../identity.js';

export interface WhoAmIContext {
  identity: AgentIdentity;
  agentMode: 'per_user' | 'single_bot';
  serverVersion: string;
  defaultWorkspace: string;
  defaultProject: string;
}

export interface WhoAmIResult {
  identity: AgentIdentity;
  agent_mode: 'per_user' | 'single_bot';
  server_version: string;
  default_workspace: string;
  default_project: string;
}

/**
 * Возвращает информацию о текущей agent-identity и сервере.
 *
 * @example
 *   await mcp.callTool('who_am_i', {})
 *   // → { identity: 'developer-agent', agent_mode: 'per_user', ... }
 */
export function whoAmI(ctx: WhoAmIContext): WhoAmIResult {
  return {
    identity: ctx.identity,
    agent_mode: ctx.agentMode,
    server_version: ctx.serverVersion,
    default_workspace: ctx.defaultWorkspace,
    default_project: ctx.defaultProject,
  };
}
