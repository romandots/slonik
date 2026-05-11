import { describe, expect, it } from 'vitest';
import { whoAmI } from './handler.js';

describe('whoAmI', () => {
  it('returns the supplied identity, mode, and metadata', () => {
    const result = whoAmI({
      identity: 'developer-agent',
      agentMode: 'per_user',
      serverVersion: '0.1.0',
      defaultWorkspace: 'agents',
      defaultProject: 'code-agents',
    });
    expect(result).toEqual({
      identity: 'developer-agent',
      agent_mode: 'per_user',
      server_version: '0.1.0',
      default_workspace: 'agents',
      default_project: 'code-agents',
    });
  });

  it('preserves single_bot mode as-is', () => {
    const result = whoAmI({
      identity: 'qa-agent',
      agentMode: 'single_bot',
      serverVersion: '0.1.0',
      defaultWorkspace: 'agents',
      defaultProject: 'code-agents',
    });
    expect(result.agent_mode).toBe('single_bot');
    expect(result.identity).toBe('qa-agent');
  });
});
