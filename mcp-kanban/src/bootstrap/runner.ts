import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { PlaneClient, type PlaneProject, type PlaneState } from '../plane-client.js';
import { PlaneError } from '../errors.js';
import type { Manifest } from './manifest.js';
import type { IdentityStore } from './store.js';

export type IdentityMode = 'per_user' | 'single_bot';

export interface BootstrapReport {
  workspace: { slug: string; created: boolean };
  projects: Array<{ slug: string; identifier: string; created: boolean }>;
  states: { total: number; created: number; existing: number };
  labels: { total: number; created: number; existing: number };
  identities: {
    mode: IdentityMode;
    invited: number;
    skipped: number;
    fallback_reason?: string;
  };
  duration_ms: number;
}

export interface RunnerDeps {
  plane: PlaneClient;
  store: IdentityStore;
  logger: Logger;
  manifest: Manifest;
  config: Pick<Config, 'MCP_AGENT_IDENTITY_MODE'>;
}

/**
 * Идемпотентный bootstrap. Шаги:
 *   1. workspace: get-by-slug; если нет — create.
 *   2. для каждого project: get-by-identifier; если нет — create.
 *   3. states: diff по name, создаём недостающие в порядке `order`.
 *   4. labels: diff по name, создаём недостающие.
 *   5. identities: в режиме per_user пытаемся пригласить через
 *      /workspaces/<slug>/invitations/. При неуспехе (404/4xx/5xx) —
 *      падаем на single_bot, пишем warning в лог и mode в store.
 *
 * Все этапы пишут report; runner возвращает структурный отчёт без логов.
 */
export async function runBootstrap(deps: RunnerDeps): Promise<BootstrapReport> {
  const { plane, manifest, logger, store, config } = deps;
  const t0 = performance.now();

  const ws = await ensureWorkspace(plane, manifest, logger);
  const projects: BootstrapReport['projects'] = [];
  let stateCreated = 0;
  let stateExisting = 0;
  let labelCreated = 0;
  let labelExisting = 0;
  let totalStates = 0;
  let totalLabels = 0;

  // Первый проект из manifest — основной (для identities default_state).
  let primaryProject: PlaneProject | undefined;
  let primaryStates: PlaneState[] = [];

  for (const projectManifest of manifest.projects) {
    const ensured = await ensureProject(plane, manifest.workspace.slug, projectManifest, logger);
    projects.push({
      slug: projectManifest.slug,
      identifier: projectManifest.identifier,
      created: ensured.created,
    });

    const stateDiff = await ensureStates(
      plane,
      manifest.workspace.slug,
      ensured.project.id,
      manifest.states,
      logger,
    );
    stateCreated += stateDiff.created;
    stateExisting += stateDiff.existing;
    totalStates += manifest.states.length;

    const labelDiff = await ensureLabels(
      plane,
      manifest.workspace.slug,
      ensured.project.id,
      manifest.labels,
      logger,
    );
    labelCreated += labelDiff.created;
    labelExisting += labelDiff.existing;
    totalLabels += manifest.labels.length;

    if (primaryProject === undefined) {
      primaryProject = ensured.project;
      primaryStates = stateDiff.states;
    }
  }

  const identityReport = await ensureIdentities({
    plane,
    store,
    logger,
    manifest,
    desiredMode: config.MCP_AGENT_IDENTITY_MODE,
  });

  // primaryProject / primaryStates сейчас нужны только для отчёта (states
  // count); полные details — в логах. Подавляем unused-warning, когда
  // identity-логике они станут нужны (Phase 5 — claim default_state).
  void primaryProject;
  void primaryStates;

  return {
    workspace: { slug: manifest.workspace.slug, created: ws.created },
    projects,
    states: { total: totalStates, created: stateCreated, existing: stateExisting },
    labels: { total: totalLabels, created: labelCreated, existing: labelExisting },
    identities: identityReport,
    duration_ms: Math.round(performance.now() - t0),
  };
}

// ---------------- workspace ----------------

async function ensureWorkspace(
  plane: PlaneClient,
  manifest: Manifest,
  logger: Logger,
): Promise<{ created: boolean }> {
  const existing = await plane.getWorkspaceBySlug(manifest.workspace.slug);
  if (existing !== undefined) {
    logger.info({ slug: manifest.workspace.slug }, 'workspace exists');
    return { created: false };
  }
  // Plane v1.3.0 workspace-scoped API token не может создавать workspaces:
  // POST /workspaces/ требует user-session-auth. Workspace должен быть
  // создан в UI до запуска bootstrap, а API-токен — взят из его
  // "Workspace settings → API tokens".
  throw new Error(
    `Workspace "${manifest.workspace.slug}" not found via API token. ` +
      `Plane API tokens are workspace-scoped and cannot create workspaces; ` +
      `create the workspace via Plane UI first and ensure PLANE_API_KEY is ` +
      `issued from its Workspace settings → API tokens.`,
  );
}

// ---------------- project ----------------

async function ensureProject(
  plane: PlaneClient,
  workspaceSlug: string,
  projectManifest: Manifest['projects'][number],
  logger: Logger,
): Promise<{ project: PlaneProject; created: boolean }> {
  const existing = await plane.getProjectByIdentifier(workspaceSlug, projectManifest.identifier);
  if (existing !== undefined) {
    logger.info(
      { workspace: workspaceSlug, identifier: projectManifest.identifier },
      'project exists',
    );
    return { project: existing, created: false };
  }
  const project = await plane.createProject(workspaceSlug, {
    name: projectManifest.name,
    identifier: projectManifest.identifier,
    module_view: projectManifest.modules.includes('modules'),
    cycle_view: projectManifest.modules.includes('cycles'),
    issue_views_view: projectManifest.modules.includes('views'),
    page_view: projectManifest.modules.includes('pages'),
  });
  logger.info(
    { workspace: workspaceSlug, identifier: project.identifier, project_id: project.id },
    'project created',
  );
  return { project, created: true };
}

// ---------------- states ----------------

async function ensureStates(
  plane: PlaneClient,
  workspaceSlug: string,
  projectId: string,
  desired: Manifest['states'],
  logger: Logger,
): Promise<{ states: PlaneState[]; created: number; existing: number }> {
  const existing = await plane.listStates(workspaceSlug, projectId);
  const byName = new Map(existing.map((s) => [s.name, s]));
  let created = 0;
  const result: PlaneState[] = [];
  for (const want of [...desired].sort((a, b) => a.order - b.order)) {
    const have = byName.get(want.name);
    if (have !== undefined) {
      result.push(have);
      continue;
    }
    const fresh = await plane.createState(workspaceSlug, projectId, {
      name: want.name,
      color: want.color,
      group: want.group,
      sequence: want.order * 1000,
      default: want.default ?? false,
    });
    result.push(fresh);
    created += 1;
    logger.info(
      { workspace: workspaceSlug, project_id: projectId, state: want.name },
      'state created',
    );
  }
  return { states: result, created, existing: desired.length - created };
}

// ---------------- labels ----------------

async function ensureLabels(
  plane: PlaneClient,
  workspaceSlug: string,
  projectId: string,
  desired: Manifest['labels'],
  logger: Logger,
): Promise<{ created: number; existing: number }> {
  const existing = await plane.listLabels(workspaceSlug, projectId);
  const byName = new Map(existing.map((l) => [l.name, l]));
  let created = 0;
  for (const want of desired) {
    if (byName.has(want.name)) continue;
    await plane.createLabel(workspaceSlug, projectId, {
      name: want.name,
      color: want.color,
    });
    created += 1;
    logger.info(
      { workspace: workspaceSlug, project_id: projectId, label: want.name },
      'label created',
    );
  }
  return { created, existing: desired.length - created };
}

// ---------------- identities ----------------

async function ensureIdentities(args: {
  plane: PlaneClient;
  store: IdentityStore;
  logger: Logger;
  manifest: Manifest;
  desiredMode: IdentityMode;
}): Promise<BootstrapReport['identities']> {
  const { plane, store, logger, manifest, desiredMode } = args;

  if (desiredMode === 'single_bot') {
    return await recordSingleBot(store, manifest, undefined);
  }

  // per_user: достаём текущих членов workspace, ищем по email; чего нет —
  // инвайтим. Любая ошибка инвайта переключает на single_bot fallback.
  let members;
  try {
    members = await plane.listWorkspaceMembers(manifest.workspace.slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'cannot list workspace members; falling back to single_bot');
    return await recordSingleBot(store, manifest, msg);
  }
  const byEmail = new Map(members.map((m) => [m.email, m]));

  let invited = 0;
  let skipped = 0;
  for (const ident of manifest.identities) {
    const existing = byEmail.get(ident.email);
    if (existing !== undefined) {
      store.upsert({
        role: ident.role,
        email: ident.email,
        plane_user_id: existing.id,
        mode: 'per_user',
      });
      skipped += 1;
      continue;
    }
    try {
      await plane.inviteWorkspaceMember(manifest.workspace.slug, {
        email: ident.email,
      });
      // Invitation.id ≠ User.id — реальный plane_user_id появится в
      // /members/ только после accept'а. До этого храним null;
      // идемпотентный повторный bootstrap подхватит реальный id из
      // workspace_members и заполнит запись.
      store.upsert({
        role: ident.role,
        email: ident.email,
        plane_user_id: null,
        mode: 'per_user',
      });
      invited += 1;
      logger.info(
        { role: ident.role, email: ident.email },
        'identity invited to workspace',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { role: ident.role, email: ident.email, err: msg },
        'cannot invite identity; falling back to single_bot',
      );
      // Откатываемся на single_bot для всего набора, иначе получится
      // частичный per_user, что хуже для воспроизводимости.
      return await recordSingleBot(store, manifest, msg);
    }
  }
  store.setMeta('identity_mode', 'per_user');
  return { mode: 'per_user', invited, skipped };
}

async function recordSingleBot(
  store: IdentityStore,
  manifest: Manifest,
  reason: string | undefined,
): Promise<BootstrapReport['identities']> {
  for (const ident of manifest.identities) {
    store.upsert({
      role: ident.role,
      email: ident.email,
      plane_user_id: null,
      mode: 'single_bot',
    });
  }
  store.setMeta('identity_mode', 'single_bot');
  return {
    mode: 'single_bot',
    invited: 0,
    skipped: manifest.identities.length,
    ...(reason !== undefined ? { fallback_reason: reason } : {}),
  };
}

// Re-export для тестов / CLI диагностики.
export { PlaneError };
