import type { PlaneClient, PlaneCycle } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';

export interface ListCyclesResult {
  workspace: string;
  project: { id: string; identifier: string };
  cycles: Array<Pick<PlaneCycle, 'id' | 'name' | 'start_date' | 'end_date'>>;
}

export async function listCycles(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  projectRef?: string;
}): Promise<ListCyclesResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined ? { projectRef: deps.projectRef } : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });
  const key = `list_cycles:${inputHash({ ws: deps.workspace, pr: project.id })}`;
  const cycles = (await deps.cache.memoize(
    key,
    async () => await deps.plane.listCycles(deps.workspace, project.id),
  )) as PlaneCycle[];
  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    cycles: cycles.map((c) => ({
      id: c.id,
      name: c.name,
      start_date: c.start_date,
      end_date: c.end_date,
    })),
  };
}
