import type { PlaneClient } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';
import { resolveModule, resolveProjectIssueIds } from '../module-resolver.js';
import { summariseModule, type ModuleSummary } from '../list-modules/handler.js';
import type { AddIssuesToModuleInput } from './schema.js';

export interface AddIssuesToModuleResult {
  ok: true;
  project: { id: string; identifier: string };
  module: ModuleSummary;
  /** Задачи, реально добавленные этим вызовом. */
  added: string[];
  /** Задачи, которые уже были в модуле — вызов идемпотентен. */
  already_present: string[];
  issues_count: number;
}

export async function addIssuesToModule(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  input: AddIssuesToModuleInput;
}): Promise<AddIssuesToModuleResult> {
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
  const missing = refs.filter((r) => !present.has(r.id));

  if (missing.length > 0) {
    await deps.plane.addModuleIssues(
      deps.workspace,
      project.id,
      module.id,
      missing.map((r) => r.id),
    );
    deps.cache.clear();
  }

  const total = (await deps.plane.listModuleIssues(deps.workspace, project.id, module.id)).length;

  return {
    ok: true,
    project: { id: project.id, identifier: project.identifier },
    module: { ...summariseModule(module), issues_count: total },
    added: missing.map((r) => r.ref),
    already_present: refs.filter((r) => present.has(r.id)).map((r) => r.ref),
    issues_count: total,
  };
}
