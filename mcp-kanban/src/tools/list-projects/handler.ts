import type { PlaneClient, PlaneProject } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';

export interface ListProjectsResult {
  workspace: string;
  projects: Array<Pick<PlaneProject, 'id' | 'identifier' | 'name'>>;
}

export async function listProjects(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  allowedProjects: string[];
}): Promise<ListProjectsResult> {
  const key = `list_projects:${inputHash({ workspace: deps.workspace })}`;
  const projects = (await deps.cache.memoize(
    key,
    async () => await deps.plane.listProjects(deps.workspace),
  )) as PlaneProject[];
  const filtered = projects.filter((p) => deps.allowedProjects.includes(p.identifier));
  return {
    workspace: deps.workspace,
    projects: filtered.map((p) => ({ id: p.id, identifier: p.identifier, name: p.name })),
  };
}
