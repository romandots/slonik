import type { PlaneClient } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { resolveProject } from '../project-resolver.js';
import { findModuleByName } from '../module-resolver.js';
import { summariseModule, type ModuleSummary } from '../list-modules/handler.js';
import type { CreateModuleInput } from './schema.js';

export interface CreateModuleResult {
  ok: true;
  /** false — модуль с таким именем уже был, вернули существующий. */
  created: boolean;
  project: { id: string; identifier: string };
  module: ModuleSummary;
}

/**
 * Создаёт модуль. Идемпотентно по имени (case-insensitive): повторный вызов
 * с тем же именем возвращает существующий модуль с `created: false`, а не
 * плодит дубликаты — агент может звать tool повторно без сверки (SLONK-34).
 */
export async function createModule(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  input: CreateModuleInput;
}): Promise<CreateModuleResult> {
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined ? { projectRef: deps.input.project } : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });

  const existing = findModuleByName(
    await deps.plane.listModules(deps.workspace, project.id),
    deps.input.name,
  );
  if (existing !== undefined) {
    return {
      ok: true,
      created: false,
      project: { id: project.id, identifier: project.identifier },
      module: summariseModule(existing),
    };
  }

  const created = await deps.plane.createModule(deps.workspace, project.id, {
    name: deps.input.name.trim(),
    ...(deps.input.description !== undefined ? { description: deps.input.description } : {}),
    ...(deps.input.status !== undefined ? { status: deps.input.status } : {}),
  });
  deps.cache.clear();

  return {
    ok: true,
    created: true,
    project: { id: project.id, identifier: project.identifier },
    module: summariseModule(created),
  };
}
