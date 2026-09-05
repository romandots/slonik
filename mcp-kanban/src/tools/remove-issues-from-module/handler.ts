import type { PlaneClient } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';
import { resolveModule, resolveProjectIssueIds } from '../module-resolver.js';
import { summariseModule, type ModuleSummary } from '../list-modules/handler.js';
import type { RemoveIssuesFromModuleInput } from './schema.js';

export interface RemoveIssuesFromModuleResult {
  ok: true;
  project: { id: string; identifier: string };
  module: ModuleSummary;
  /** Задачи, реально откреплённые этим вызовом. */
  removed: string[];
  /** Задачи, которых в модуле и не было — вызов идемпотентен. */
  not_in_module: string[];
  issues_count: number;
}

export async function removeIssuesFromModule(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  input: RemoveIssuesFromModuleInput;
}): Promise<RemoveIssuesFromModuleResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined ? { projectRef: deps.input.project } : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });
  const module = await resolveModule({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    projectId: project.id,
    moduleRef: deps.input.module,
  });
  const refs = await resolveProjectIssueIds({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    project,
    refs: deps.input.issue_ids,
  });

  const present = new Set(
    (await deps.plane.listModuleIssues(deps.workspace, project.id, module.id)).map((mi) => mi.issue),
  );
  const toRemove = refs.filter((r) => present.has(r.id));

  for (const r of toRemove) {
    await deps.plane.removeModuleIssue(deps.workspace, project.id, module.id, r.id);
  }
  if (toRemove.length > 0) deps.cache.clear();

  const total = (await deps.plane.listModuleIssues(deps.workspace, project.id, module.id)).length;

  return {
    ok: true,
    project: { id: project.id, identifier: project.identifier },
    module: { ...summariseModule(module), issues_count: total },
    removed: toRemove.map((r) => r.ref),
    not_in_module: refs.filter((r) => !present.has(r.id)).map((r) => r.ref),
    issues_count: total,
  };
}
