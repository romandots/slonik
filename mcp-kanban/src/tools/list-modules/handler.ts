import type { PlaneClient, PlaneModule } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';

export interface ListModulesResult {
  workspace: string;
  project: { id: string; identifier: string };
  modules: Array<Pick<PlaneModule, 'id' | 'name' | 'description' | 'status'>>;
}

export async function listModules(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  projectRef?: string;
}): Promise<ListModulesResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined ? { projectRef: deps.projectRef } : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });
  const key = `list_modules:${inputHash({ ws: deps.workspace, pr: project.id })}`;
  const mods = (await deps.cache.memoize(
    key,
    async () => await deps.plane.listModules(deps.workspace, project.id),
  )) as PlaneModule[];
  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    modules: mods.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.description !== undefined ? { description: m.description } : {}),
      ...(m.status !== undefined ? { status: m.status } : {}),
    })),
  };
}
