import { McpError } from '../errors.js';
import type { PlaneClient, PlaneModule } from '../plane-client.js';
import { parseIssueRef } from './get-issue/schema.js';
import { resolveIssueId } from './update-issue/handler.js';

// Резолвер «имя/uuid → PlaneModule». Агенту удобнее назвать модуль так же,
// как он видит его в UI («Уведомления»), поэтому tools принимают оба вида
// ссылки — как и в остальных инструментах (SLONK-34).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Нормализация имени для идемпотентного сравнения: trim + lowercase. */
export function normaliseModuleName(name: string): string {
  return name.trim().toLowerCase();
}

/** Ищет модуль по имени (case-insensitive) среди уже загруженного списка. */
export function findModuleByName(modules: PlaneModule[], name: string): PlaneModule | undefined {
  const wanted = normaliseModuleName(name);
  return modules.find((m) => normaliseModuleName(m.name) === wanted);
}

export async function resolveModule(opts: {
  plane: PlaneClient;
  workspaceSlug: string;
  projectId: string;
  moduleRef: string;
}): Promise<PlaneModule> {
  const ref = opts.moduleRef.trim();
  const modules = await opts.plane.listModules(opts.workspaceSlug, opts.projectId);
  const matched = UUID_RE.test(ref)
    ? modules.find((m) => m.id === ref)
    : (findModuleByName(modules, ref) ?? modules.find((m) => m.id === ref));
  if (matched === undefined) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `Module '${ref}' not found in project '${opts.projectId}'`,
    });
  }
  return matched;
}

/**
 * Резолвит список ссылок на задачи (`SLONK-12` или UUID) в UUID внутри
 * ОДНОГО проекта — модуль не может содержать задачи чужого проекта.
 * Ссылку с чужим префиксом отвергаем явно, иначе `SLONK-12` и `OTHER-12`
 * молча резолвились бы в одну и ту же задачу.
 */
export async function resolveProjectIssueIds(opts: {
  plane: PlaneClient;
  workspaceSlug: string;
  project: { id: string; identifier: string };
  refs: string[];
}): Promise<Array<{ ref: string; id: string }>> {
  const out: Array<{ ref: string; id: string }> = [];
  for (const ref of opts.refs) {
    const parsed = parseIssueRef(ref);
    if (
      parsed.kind === 'sequence' &&
      parsed.identifier !== undefined &&
      parsed.identifier !== opts.project.identifier
    ) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `Issue '${ref}' belongs to project '${parsed.identifier}', but the module lives in '${opts.project.identifier}'`,
      });
    }
    const id = await resolveIssueId(opts.plane, opts.workspaceSlug, opts.project, parsed);
    if (!out.some((e) => e.id === id)) out.push({ ref, id });
  }
  return out;
}
