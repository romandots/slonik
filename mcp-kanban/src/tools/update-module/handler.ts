import type { PlaneClient, PlaneModuleStatus } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import { McpError } from '../../errors.js';
import { resolveProject } from '../project-resolver.js';
import { findModuleByName, normaliseModuleName, resolveModule } from '../module-resolver.js';
import { summariseModule, type ModuleSummary } from '../list-modules/handler.js';
import type { UpdateModuleInput } from './schema.js';

export interface UpdateModuleResult {
  ok: true;
  project: { id: string; identifier: string };
  module: ModuleSummary;
}

export async function updateModule(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  input: UpdateModuleInput;
}): Promise<UpdateModuleResult> {
  const { name, description, status } = deps.input;
  if (name === undefined && description === undefined && status === undefined) {
    throw new McpError({
      code: 'INVALID_INPUT',
      message: 'At least one of name/description/status must be provided',
    });
  }

  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined ? { projectRef: deps.input.project } : {}),
    defaultProjectRef: deps.defaultProjectRef,
  });
  const target = await resolveModule({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    projectId: project.id,
    moduleRef: deps.input.module,
  });

  // Переименование в уже занятое имя Plane не отвергает — получился бы
  // «тихий» дубликат, который потом ломает резолв по имени. Ловим сами.
  if (name !== undefined && normaliseModuleName(name) !== normaliseModuleName(target.name)) {
    const clash = findModuleByName(
      await deps.plane.listModules(deps.workspace, project.id),
      name,
    );
    if (clash !== undefined) {
      throw new McpError({
        code: 'CONFLICT',
        message: `Module '${clash.name}' already exists in project ${project.identifier}`,
      });
    }
  }

  const patch: { name?: string; description?: string; status?: PlaneModuleStatus } = {};
  if (name !== undefined) patch.name = name.trim();
  if (description !== undefined) patch.description = description;
  if (status !== undefined) patch.status = status;

  const updated = await deps.plane.updateModule(deps.workspace, project.id, target.id, patch);
  deps.cache.clear();

  return {
    ok: true,
    project: { id: project.id, identifier: project.identifier },
    module: summariseModule(updated),
  };
}
