import type { PlaneClient, PlaneWorkspace } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';

export interface ListWorkspacesResult {
  workspaces: Array<Pick<PlaneWorkspace, 'id' | 'slug' | 'name'>>;
}

export async function listWorkspaces(deps: {
  plane: PlaneClient;
  cache: TtlCache;
}): Promise<ListWorkspacesResult> {
  const all = (await deps.cache.memoize(
    'list_workspaces',
    async () => await deps.plane.listWorkspaces(),
  )) as PlaneWorkspace[];
  return { workspaces: all.map((w) => ({ id: w.id, slug: w.slug, name: w.name })) };
}
