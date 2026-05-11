import type {
  PlaneClient,
  PlaneIssue,
  PlaneLabel,
  PlaneState,
} from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { McpError } from '../../errors.js';
import { parseDescription, type MetaBlock } from '../../meta-block.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from './schema.js';
import { summarise, type IssueSummary } from '../list-issues/handler.js';

export interface GetIssueResult extends IssueSummary {
  description_body: string;
  description_raw: string | undefined;
  meta: MetaBlock;
  meta_corrupt: boolean;
  meta_error?: string;
}

export async function getIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  issueRef: string;
  projectRef?: string;
}): Promise<GetIssueResult> {
  const parsed = parseIssueRef(deps.issueRef);
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined
      ? { projectRef: deps.projectRef }
      : parsed.kind === 'sequence' && parsed.identifier !== undefined
        ? { projectRef: parsed.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });

  const cacheKey = `get_issue:${inputHash({ ws: deps.workspace, pr: project.id, ref: deps.issueRef })}`;
  const issue = await deps.cache.memoize(cacheKey, async () => {
    if (parsed.kind === 'uuid' && parsed.uuid !== undefined) {
      return await deps.plane.getIssue(deps.workspace, project.id, parsed.uuid);
    }
    if (parsed.kind === 'sequence' && parsed.sequence !== undefined) {
      return await deps.plane.getIssueBySequenceId(
        deps.workspace,
        project.id,
        project.identifier,
        parsed.sequence,
      );
    }
    return undefined;
  });

  if (issue === undefined || issue === null) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `Issue '${deps.issueRef}' not found in ${project.identifier}`,
    });
  }
  const realIssue = issue as PlaneIssue;

  const [states, labels] = await Promise.all([
    deps.cache.memoize(
      `list_states:${inputHash({ ws: deps.workspace, pr: project.id })}`,
      async () => await deps.plane.listStates(deps.workspace, project.id),
    ) as Promise<PlaneState[]>,
    deps.cache.memoize(
      `list_labels:${inputHash({ ws: deps.workspace, pr: project.id })}`,
      async () => await deps.plane.listLabels(deps.workspace, project.id),
    ) as Promise<PlaneLabel[]>,
  ]);

  const summary = summarise(realIssue, states, labels, project.identifier);
  const description = realIssue.description ?? realIssue.description_html ?? '';
  const meta = parseDescription(description);
  return {
    ...summary,
    description_body: meta.body,
    description_raw: description,
    meta: meta.meta,
    meta_corrupt: meta.corrupt,
    ...(meta.error !== undefined ? { meta_error: meta.error } : {}),
  };
}
