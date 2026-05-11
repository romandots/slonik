import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpError } from '../errors.js';
import { whoAmI } from './who-am-i/handler.js';
import type { ToolContext } from './context.js';
import { listWorkspaces } from './list-workspaces/handler.js';
import { listProjects } from './list-projects/handler.js';
import { listStates } from './list-states/handler.js';
import { listLabels } from './list-labels/handler.js';
import { listCycles } from './list-cycles/handler.js';
import { listModules } from './list-modules/handler.js';
import { listIssues } from './list-issues/handler.js';
import { ListIssuesInput } from './list-issues/schema.js';
import { getIssue } from './get-issue/handler.js';
import { GetIssueInput } from './get-issue/schema.js';
import { searchIssues } from './search-issues/handler.js';
import { SearchIssuesInput } from './search-issues/schema.js';
import { getIssueHistory } from './get-issue-history/handler.js';
import { GetIssueHistoryInput } from './get-issue-history/schema.js';
import { createIssue } from './create-issue/handler.js';
import { CreateIssueInput } from './create-issue/schema.js';
import { updateIssue } from './update-issue/handler.js';
import { UpdateIssueInput } from './update-issue/schema.js';
import { transitionIssue } from './transition-issue/handler.js';
import { TransitionIssueInput } from './transition-issue/schema.js';
import { claimIssue } from './claim-issue/handler.js';
import { ClaimIssueInput } from './claim-issue/schema.js';
import { releaseIssue } from './release-issue/handler.js';
import { ReleaseIssueInput } from './release-issue/schema.js';
import { blockIssue } from './block-issue/handler.js';
import { BlockIssueInput } from './block-issue/schema.js';
import { commentIssue } from './comment-issue/handler.js';
import { CommentIssueInput } from './comment-issue/schema.js';
import { attachFile } from './attach-file/handler.js';
import { AttachFileInput } from './attach-file/schema.js';
import { linkGitRef } from './link-git-ref/handler.js';
import { LinkGitRefInput, LinkGitRefShape } from './link-git-ref/schema.js';
import { unlinkGitRef } from './unlink-git-ref/handler.js';
import { UnlinkGitRefInput } from './unlink-git-ref/schema.js';
import { findIssuesByGitRef } from './find-issues-by-git-ref/handler.js';
import { FindIssuesByGitRefInput, FindIssuesByGitRefShape } from './find-issues-by-git-ref/schema.js';
import { hashInput, newTraceId } from '../audit.js';

export type { ToolContext } from './context.js';

/** Зарегистрированные tools (имена) — используется /mcp/tools для debug. */
export const REGISTERED_TOOL_NAMES = [
  'who_am_i',
  'list_workspaces',
  'list_projects',
  'list_states',
  'list_labels',
  'list_cycles',
  'list_modules',
  'list_issues',
  'get_issue',
  'search_issues',
  'get_issue_history',
  'create_issue',
  'update_issue',
  'transition_issue',
  'claim_issue',
  'release_issue',
  'block_issue',
  'comment_issue',
  'attach_file',
  'link_git_ref',
  'unlink_git_ref',
  'find_issues_by_git_ref',
] as const;
export type RegisteredToolName = (typeof REGISTERED_TOOL_NAMES)[number];

const WRITE_TOOLS = new Set<RegisteredToolName>([
  'create_issue',
  'update_issue',
  'transition_issue',
  'claim_issue',
  'release_issue',
  'block_issue',
  'comment_issue',
  'attach_file',
  'link_git_ref',
  'unlink_git_ref',
]);

// MCP SDK ожидает у tool-callback'а возврат с индексной сигнатурой
// `[x: string]: unknown`. Используем простой Record-тип, чтобы TS видел
// совместимость без `as any`.
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  [k: string]: unknown;
};

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function asError(err: unknown): ToolResult {
  const code = err instanceof McpError ? err.code : 'INTERNAL';
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message } }, null, 2) }],
    structuredContent: { ok: false, error: { code, message } },
  };
}

/**
 * Обёртка для write-tools: rate-limit + trace_id + audit-write вокруг
 * пользовательского handler'а. Read-tools идут мимо этой обёртки.
 */
async function withWriteGuard<T>(args: {
  ctx: ToolContext;
  tool: RegisteredToolName;
  input: unknown;
  issueIdFromInput?: (input: unknown) => string | undefined;
  fn: (traceId: string) => Promise<T>;
}): Promise<ToolResult> {
  const traceId = newTraceId();
  const identity = args.ctx.resolveIdentity();
  try {
    args.ctx.rateLimiter.consume(identity);
  } catch (err) {
    args.ctx.audit.record({
      trace_id: traceId,
      identity,
      tool: args.tool,
      input_hash: hashInput(args.input),
      plane_request_id: null,
      outcome: 'error',
      error_code: err instanceof McpError ? err.code : 'INTERNAL',
      event: null,
      issue_id: args.issueIdFromInput?.(args.input) ?? null,
    });
    return asError(err);
  }
  try {
    const result = await args.fn(traceId);
    args.ctx.audit.record({
      trace_id: traceId,
      identity,
      tool: args.tool,
      input_hash: hashInput(args.input),
      plane_request_id: null,
      outcome: 'success',
      error_code: null,
      event: args.tool === 'claim_issue' ? 'claim' : null,
      issue_id: args.issueIdFromInput?.(args.input) ?? null,
    });
    return ok(result);
  } catch (err) {
    args.ctx.audit.record({
      trace_id: traceId,
      identity,
      tool: args.tool,
      input_hash: hashInput(args.input),
      plane_request_id: null,
      outcome: 'error',
      error_code: err instanceof McpError ? err.code : 'INTERNAL',
      event: args.tool === 'claim_issue' ? 'claim' : null,
      issue_id: args.issueIdFromInput?.(args.input) ?? null,
    });
    return asError(err);
  }
}

void WRITE_TOOLS; // используется в audit-обёртках, оставляем для будущих feature

export function registerTools(server: McpServer, ctx: ToolContext): void {
  // ---- who_am_i ----
  server.registerTool(
    'who_am_i',
    {
      description: 'Return current agent identity and server metadata.',
      inputSchema: {},
    },
    () => {
      try {
        const result = whoAmI({
          identity: ctx.resolveIdentity(),
          agentMode: ctx.resolveIdentityMode(),
          serverVersion: ctx.serverVersion,
          defaultWorkspace: ctx.defaultWorkspace,
          defaultProject: ctx.defaultProjectSlug,
        });
        return ok(result);
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- list_workspaces ----
  server.registerTool(
    'list_workspaces',
    {
      description: 'List Plane workspaces visible to the MCP server.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await listWorkspaces({ plane: ctx.plane, cache: ctx.cache }));
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- list_projects ----
  server.registerTool(
    'list_projects',
    {
      description: 'List projects in the default workspace (or one specified by slug).',
      inputSchema: { workspace: z.string().min(1).optional() },
    },
    async (args) => {
      try {
        return ok(
          await listProjects({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: args.workspace ?? ctx.defaultWorkspace,
            allowedProjects: ctx.allowedProjects,
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- list_states ----
  server.registerTool(
    'list_states',
    {
      description: 'List workflow states for the resolved project.',
      inputSchema: { project: z.string().min(1).optional() },
    },
    async (args) => {
      try {
        return ok(
          await listStates({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            ...(args.project !== undefined ? { projectRef: args.project } : {}),
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- list_labels ----
  server.registerTool(
    'list_labels',
    {
      description: 'List labels for the resolved project.',
      inputSchema: { project: z.string().min(1).optional() },
    },
    async (args) => {
      try {
        return ok(
          await listLabels({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            ...(args.project !== undefined ? { projectRef: args.project } : {}),
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- list_cycles ----
  server.registerTool(
    'list_cycles',
    {
      description: 'List cycles (sprints) for the resolved project.',
      inputSchema: { project: z.string().min(1).optional() },
    },
    async (args) => {
      try {
        return ok(
          await listCycles({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            ...(args.project !== undefined ? { projectRef: args.project } : {}),
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- list_modules ----
  server.registerTool(
    'list_modules',
    {
      description: 'List modules (epics) for the resolved project.',
      inputSchema: { project: z.string().min(1).optional() },
    },
    async (args) => {
      try {
        return ok(
          await listModules({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            ...(args.project !== undefined ? { projectRef: args.project } : {}),
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- list_issues ----
  server.registerTool(
    'list_issues',
    {
      description: 'Search issues by state/label/assignee/cycle/priority filters.',
      inputSchema: ListIssuesInput.shape,
    },
    async (args) => {
      try {
        const input = ListIssuesInput.parse(args);
        return ok(
          await listIssues({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            input,
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- get_issue ----
  server.registerTool(
    'get_issue',
    {
      description: 'Fetch full issue (with parsed slonk:meta block).',
      inputSchema: GetIssueInput.shape,
    },
    async (args) => {
      try {
        const input = GetIssueInput.parse(args);
        return ok(
          await getIssue({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            issueRef: input.issue_id,
            ...(input.project !== undefined ? { projectRef: input.project } : {}),
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- search_issues ----
  server.registerTool(
    'search_issues',
    {
      description: 'Full-text search across issue title/description/comments.',
      inputSchema: SearchIssuesInput.shape,
    },
    async (args) => {
      try {
        const input = SearchIssuesInput.parse(args);
        return ok(
          await searchIssues({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            query: input.query,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.project !== undefined ? { projectRef: input.project } : {}),
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- get_issue_history ----
  server.registerTool(
    'get_issue_history',
    {
      description: 'Combined Plane activity + comments timeline for an issue.',
      inputSchema: GetIssueHistoryInput.shape,
    },
    async (args) => {
      try {
        const input = GetIssueHistoryInput.parse(args);
        return ok(
          await getIssueHistory({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            issueRef: input.issue_id,
            ...(input.project !== undefined ? { projectRef: input.project } : {}),
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  // ---- create_issue ----
  server.registerTool(
    'create_issue',
    {
      description: 'Create a new issue in the default project.',
      inputSchema: CreateIssueInput.shape,
    },
    async (args) => {
      const input = CreateIssueInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'create_issue',
        input,
        fn: async () =>
          await createIssue({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            input,
          }),
      });
    },
  );

  // ---- update_issue ----
  server.registerTool(
    'update_issue',
    {
      description: 'Update fields of an existing issue (name/description/priority/labels/assignees).',
      inputSchema: UpdateIssueInput.shape,
    },
    async (args) => {
      const input = UpdateIssueInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'update_issue',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async () =>
          await updateIssue({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            input,
          }),
      });
    },
  );

  // ---- transition_issue ----
  server.registerTool(
    'transition_issue',
    {
      description: 'Move an issue to a new state, optionally posting a comment.',
      inputSchema: TransitionIssueInput.shape,
    },
    async (args) => {
      const input = TransitionIssueInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'transition_issue',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async () =>
          await transitionIssue({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            identity: ctx.resolveIdentity(),
            input,
          }),
      });
    },
  );

  // ---- claim_issue ----
  server.registerTool(
    'claim_issue',
    {
      description: 'Atomically claim an issue: assign self, move to role-default state, mark agent-claimed.',
      inputSchema: ClaimIssueInput.shape,
    },
    async (args) => {
      const input = ClaimIssueInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'claim_issue',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async (traceId) =>
          await claimIssue({
            plane: ctx.plane,
            cache: ctx.cache,
            audit: ctx.audit,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            identity: ctx.resolveIdentity(),
            traceId,
            planeUserId: ctx.resolvePlaneUserId(),
            input,
          }),
      });
    },
  );

  // ---- release_issue ----
  server.registerTool(
    'release_issue',
    {
      description: 'Release a previously claimed issue back to "To Do".',
      inputSchema: ReleaseIssueInput.shape,
    },
    async (args) => {
      const input = ReleaseIssueInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'release_issue',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async () =>
          await releaseIssue({
            plane: ctx.plane,
            cache: ctx.cache,
            audit: ctx.audit,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            identity: ctx.resolveIdentity(),
            planeUserId: ctx.resolvePlaneUserId(),
            input,
          }),
      });
    },
  );

  // ---- block_issue ----
  server.registerTool(
    'block_issue',
    {
      description: 'Move issue to Blocked and label as agent-blocked with a reason comment.',
      inputSchema: BlockIssueInput.shape,
    },
    async (args) => {
      const input = BlockIssueInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'block_issue',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async () =>
          await blockIssue({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            identity: ctx.resolveIdentity(),
            input,
          }),
      });
    },
  );

  // ---- comment_issue ----
  server.registerTool(
    'comment_issue',
    {
      description: 'Post a comment on an issue, prefixed with the current identity.',
      inputSchema: CommentIssueInput.shape,
    },
    async (args) => {
      const input = CommentIssueInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'comment_issue',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async () =>
          await commentIssue({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            identity: ctx.resolveIdentity(),
            input,
          }),
      });
    },
  );

  // ---- attach_file ----
  server.registerTool(
    'attach_file',
    {
      description: 'Two-phase file attach: get presigned URL, then complete with object_key.',
      inputSchema: AttachFileInput.shape,
    },
    async (args) => {
      const input = AttachFileInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'attach_file',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async () =>
          await attachFile({
            plane: ctx.plane,
            cache: ctx.cache,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            identity: ctx.resolveIdentity(),
            bucket: ctx.minioBucket,
            endpoint: ctx.minioEndpoint,
            expiresInSec: ctx.signedUrlExpirationSec,
            input,
          }),
      });
    },
  );

  // ---- link_git_ref ----
  server.registerTool(
    'link_git_ref',
    {
      description: 'Idempotently add a git ref (repo+branch+pr+commit) to an issue meta block.',
      inputSchema: LinkGitRefShape,
    },
    async (args) => {
      const input = LinkGitRefInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'link_git_ref',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async () =>
          await linkGitRef({
            plane: ctx.plane,
            cache: ctx.cache,
            gitRefs: ctx.gitRefs,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            input,
          }),
      });
    },
  );

  // ---- unlink_git_ref ----
  server.registerTool(
    'unlink_git_ref',
    {
      description: 'Remove a git ref from the issue meta block and local index.',
      inputSchema: UnlinkGitRefInput.shape,
    },
    async (args) => {
      const input = UnlinkGitRefInput.parse(args);
      return await withWriteGuard({
        ctx,
        tool: 'unlink_git_ref',
        input,
        issueIdFromInput: (i) => (i as typeof input).issue_id,
        fn: async () =>
          await unlinkGitRef({
            plane: ctx.plane,
            cache: ctx.cache,
            gitRefs: ctx.gitRefs,
            workspace: ctx.defaultWorkspace,
            defaultProjectRef: ctx.defaultProjectSlug,
            allowedProjects: ctx.allowedProjects,
            input,
          }),
      });
    },
  );

  // ---- find_issues_by_git_ref ----
  // Read-only: индексный lookup, без обращения к Plane. Не пишем в audit.
  server.registerTool(
    'find_issues_by_git_ref',
    {
      description: 'Find issues by repo_url / branch / pr_url / commit using the local git index.',
      inputSchema: FindIssuesByGitRefShape,
    },
    async (args) => {
      try {
        const input = FindIssuesByGitRefInput.parse(args);
        return ok(findIssuesByGitRef({ gitRefs: ctx.gitRefs, input }));
      } catch (err) {
        return asError(err);
      }
    },
  );
}
