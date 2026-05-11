import { McpError } from '../errors.js';
import type { PlaneClient, PlaneProject } from '../plane-client.js';

// Резолвер «slug/identifier/project_id → PlaneProject». Tools принимают
// удобный для агента вход (имя или идентификатор), резолвер приводит к
// внутреннему `project.id` через listProjects + match. Allow-list проверяет,
// что проект разрешён MCP-конфигом.

export async function resolveProject(opts: {
  plane: PlaneClient;
  workspaceSlug: string;
  projectRef?: string;
  defaultProjectRef: string;
  allowedProjects: string[];
}): Promise<PlaneProject> {
  const ref = (opts.projectRef ?? opts.defaultProjectRef).trim();
  if (!opts.allowedProjects.includes(ref)) {
    // Допускаем default из конфига, даже если его нет в allowed.
    if (ref !== opts.defaultProjectRef) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `Project '${ref}' is not in MCP_ALLOWED_PROJECTS`,
      });
    }
  }
  const projects = await opts.plane.listProjects(opts.workspaceSlug);
  const matched = projects.find(
    (p) => p.identifier === ref || p.name === ref || normaliseSlug(p.name) === ref || p.id === ref,
  );
  if (matched === undefined) {
    throw new McpError({
      code: 'NOT_FOUND',
      message: `Project '${ref}' not found in workspace '${opts.workspaceSlug}'`,
    });
  }
  return matched;
}

function normaliseSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
