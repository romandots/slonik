import type { PlaneClient, PlaneModule } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { inputHash } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';

export interface ModuleSummary {
  id: string;
  name: string;
  description?: string;
  status?: string;
  /**
   * Количество карточек в модуле. Берём из аннотации `total_issues`,
   * которую Plane отдаёт прямо в списке модулей — дополнительных запросов
   * ради счётчика не делаем. Если апстрим поле не вернул, оно отсутствует
   * (SLONK-34).
   */
  issues_count?: number;
}

export interface ListModulesResult {
  workspace: string;
  project: { id: string; identifier: string };
  modules: ModuleSummary[];
}

/** Единый маппинг Plane-модуля в ответ tool'а (используется всеми module-tools). */
export function summariseModule(m: PlaneModule): ModuleSummary {
  return {
    id: m.id,
    name: m.name,
    ...(m.description !== undefined ? { description: m.description } : {}),
    ...(m.status !== undefined ? { status: m.status } : {}),
    ...(m.total_issues !== undefined ? { issues_count: m.total_issues } : {}),
  };
}

export async function listModules(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  projectRef?: string;
}): Promise<ListModulesResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.projectRef !== undefined ? { projectRef: deps.projectRef } : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });
  const key = `list_modules:${inputHash({ ws: deps.workspace, pr: project.id })}`;
  const mods = (await deps.cache.memoize(
    key,
    async () => await deps.plane.listModules(deps.workspace, project.id),
  )) as PlaneModule[];
  return {
    workspace: deps.workspace,
    project: { id: project.id, identifier: project.identifier },
    modules: mods.map(summariseModule),
  };
}
