import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { PlaneClient, type PlaneProject, type PlaneState } from '../plane-client.js';
import { PlaneError } from '../errors.js';
import type { Manifest } from './manifest.js';
import type { RoleDefinition } from './roles.js';
import type { IdentityStore } from './store.js';

export type IdentityMode = 'per_user' | 'single_bot';

/**
 * Источник identity для bootstrap'а. SLONK-6:
 *   - `roles/` (массив `RoleDefinition`, prim'ary source);
 *   - `manifest.yaml.identities` (legacy fallback для инсталляций,
 *     обновляющихся с версии без поддержки `roles/`).
 *
 * Runner получает уже готовый источник: cli.ts вызывает `loadRoles()` и
 * передаёт сюда либо `{ kind: 'roles', roles }`, либо
 * `{ kind: 'manifest' }`. Тесты передают `kind: 'roles'` с
 * inline-массивом.
 */
export type IdentitiesSource =
  | { kind: 'roles'; roles: RoleDefinition[] }
  | { kind: 'manifest' };

export interface BootstrapProjectError {
  /** Стабильный код для grep/мониторинга. На сегодня — единственное значение. */
  code: 'PROJECT_BOOTSTRAP_FAILED';
  /** Человекочитаемое сообщение исходной ошибки (Plane / network / pre-flight). */
  message: string;
}

export interface BootstrapProjectReport {
  slug: string;
  identifier: string;
  created: boolean;
  /** Заполняется, если на этом проекте упали ensureProject / ensureStates / ensureLabels. */
  error?: BootstrapProjectError;
}

export interface BootstrapReport {
  workspace: { slug: string; created: boolean };
  projects: BootstrapProjectReport[];
  states: {
    total: number;
    created: number;
    existing: number;
    renamed: number;
    deleted: number;
    /** Сироты, которые не удалось удалить (например — есть привязанные задачи). */
    delete_failed: number;
  };
  labels: { total: number; created: number; existing: number };
  identities: {
    mode: IdentityMode;
    invited: number;
    skipped: number;
    /** SLONK-6: какой источник identities использовался (`roles/` vs `manifest`). */
    source: 'roles' | 'manifest';
    fallback_reason?: string;
  };
  duration_ms: number;
}

export interface RunnerDeps {
  plane: PlaneClient;
  store: IdentityStore;
  logger: Logger;
  manifest: Manifest;
  /**
   * Источник identity. SLONK-6: основной — `{ kind: 'roles', roles: [...] }`,
   * fallback — `{ kind: 'manifest' }`. Если параметр не передан, runner
   * читает `manifest.identities` (для обратной совместимости с тестами).
   */
  identitiesSource?: IdentitiesSource;
  config: Pick<Config, 'MCP_AGENT_IDENTITY_MODE'>;
}

/**
 * Идемпотентный bootstrap. Шаги:
 *   1. workspace: get-by-slug; если нет — create.
 *   2. для каждого project: get-by-identifier; если нет — create.
 *   3. states: реконсиляция с манифестом. Совпавшие по name — оставляем;
 *      недостающие — переиспользуем «осиротевший» дефолт Plane той же
 *      group (PATCH name/color/sequence) либо создаём новый; состояния
 *      не из манифеста (и не `default`) — удаляем. Bootstrap → source of
 *      truth для набора состояний.
 *   4. labels: diff по name, создаём недостающие.
 *   5. identities: в режиме per_user пытаемся пригласить через
 *      /workspaces/<slug>/invitations/. При неуспехе (404/4xx/5xx) —
 *      падаем на single_bot, пишем warning в лог и mode в store.
 *
 * Все этапы пишут report; runner возвращает структурный отчёт без логов.
 */
export async function runBootstrap(deps: RunnerDeps): Promise<BootstrapReport> {
  const { plane, manifest, logger, store, config } = deps;
  const identitiesSource: IdentitiesSource =
    deps.identitiesSource ?? { kind: 'manifest' };
  const t0 = performance.now();

  const ws = await ensureWorkspace(plane, manifest, logger);
  const projects: BootstrapReport['projects'] = [];
  let stateCreated = 0;
  let stateExisting = 0;
  let stateRenamed = 0;
  let stateDeleted = 0;
  let stateDeleteFailed = 0;
  let labelCreated = 0;
  let labelExisting = 0;
  let totalStates = 0;
  let totalLabels = 0;

  // Первый проект из manifest — основной (для identities default_state).
  let primaryProject: PlaneProject | undefined;
  let primaryStates: PlaneState[] = [];

  // Resilient-цикл: один кривой проект (например — Plane 400 на name с em-dash
  // или сетевой сбой посреди ensureStates) не должен ронять весь bootstrap.
  // Ловим ошибку на уровне «один проект» и идём дальше; падение фиксируется в
  // BootstrapReport.projects[i].error и в WARN-логе. Identities (workspace-level)
  // отрабатываются после цикла независимо. CLI читает наличие error[] и
  // возвращает non-zero exit code.
  for (const projectManifest of manifest.projects) {
    const report: BootstrapProjectReport = {
      slug: projectManifest.slug,
      identifier: projectManifest.identifier,
      created: false,
    };
    try {
      const ensured = await ensureProject(
        plane,
        manifest.workspace.slug,
        projectManifest,
        logger,
      );
      report.created = ensured.created;

      const stateDiff = await ensureStates(
        plane,
        manifest.workspace.slug,
        ensured.project.id,
        manifest.states,
        logger,
      );
      stateCreated += stateDiff.created;
      stateExisting += stateDiff.existing;
      stateRenamed += stateDiff.renamed;
      stateDeleted += stateDiff.deleted;
      stateDeleteFailed += stateDiff.delete_failed;
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.error = { code: 'PROJECT_BOOTSTRAP_FAILED', message: msg };
      logger.error(
        {
          workspace: manifest.workspace.slug,
          project: projectManifest.identifier,
          slug: projectManifest.slug,
          err: msg,
        },
        'project bootstrap failed; skipping and continuing with the rest',
      );
    }
    projects.push(report);
  }

  const identityReport = await ensureIdentities({
    plane,
    store,
    logger,
    manifest,
    source: identitiesSource,
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
    states: {
      total: totalStates,
      created: stateCreated,
      existing: stateExisting,
      renamed: stateRenamed,
      deleted: stateDeleted,
      delete_failed: stateDeleteFailed,
    },
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
): Promise<{
  states: PlaneState[];
  created: number;
  existing: number;
  renamed: number;
  deleted: number;
  delete_failed: number;
}> {
  const existing = await plane.listStates(workspaceSlug, projectId);
  const desiredNames = new Set(desired.map((s) => s.name));
  const byName = new Map(existing.map((s) => [s.name, s]));

  // «Сироты» — состояния, которых нет в манифесте и которые не `default`.
  // Plane при создании проекта плодит дефолтные `Todo` / `In Progress`:
  // их можно переиспользовать (PATCH) под манифестное состояние той же
  // group, а лишние — удалить. `default`-состояние не трогаем никогда.
  const orphansByGroup = new Map<PlaneState['group'], PlaneState[]>();
  for (const s of existing) {
    if (desiredNames.has(s.name) || s.default) continue;
    const list = orphansByGroup.get(s.group) ?? [];
    list.push(s);
    orphansByGroup.set(s.group, list);
  }

  let created = 0;
  let renamed = 0;
  const result: PlaneState[] = [];
  const consumed = new Set<string>(); // id переиспользованных сирот

  for (const want of [...desired].sort((a, b) => a.order - b.order)) {
    const have = byName.get(want.name);
    if (have !== undefined) {
      result.push(have);
      continue;
    }
    const reuse = orphansByGroup.get(want.group)?.shift();
    if (reuse !== undefined) {
      const patched = await plane.updateState(workspaceSlug, projectId, reuse.id, {
        name: want.name,
        color: want.color,
        group: want.group,
        sequence: want.order * 1000,
        default: want.default ?? false,
      });
      result.push(patched);
      consumed.add(reuse.id);
      renamed += 1;
      logger.info(
        { workspace: workspaceSlug, project_id: projectId, from: reuse.name, to: want.name },
        'state reused (renamed from Plane default)',
      );
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

  // Лишние состояния (не из манифеста, не `default`, не переиспользованные)
  // — удаляем: bootstrap = source of truth для набора колонок. Список
  // считаем заранее, чтобы не зависеть от того, мутирует ли реализация
  // listStates исходный массив при delete. Удаление — best-effort: если
  // Plane отказал (например, у колонки есть привязанные задачи), пишем
  // warn и идём дальше — bootstrap не должен падать из-за чужой колонки.
  const toDelete = existing.filter(
    (s) => !desiredNames.has(s.name) && !s.default && !consumed.has(s.id),
  );
  let deleted = 0;
  let deleteFailed = 0;
  for (const s of toDelete) {
    try {
      await plane.deleteState(workspaceSlug, projectId, s.id);
      deleted += 1;
      logger.info(
        { workspace: workspaceSlug, project_id: projectId, state: s.name },
        'state deleted (not in manifest)',
      );
    } catch (err) {
      deleteFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { workspace: workspaceSlug, project_id: projectId, state: s.name, err: msg },
        'cannot delete non-manifest state; skipping (likely has attached issues)',
      );
    }
  }

  return {
    states: result,
    created,
    existing: desired.length - created - renamed,
    renamed,
    deleted,
    delete_failed: deleteFailed,
  };
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

/**
 * Унифицированное представление identity, с которым работает runner.
 * Собирается из `RoleDefinition` (SLONK-6 — primary source) или из
 * `manifest.identities` (legacy fallback). `default_state` и
 * `state_aliases` идут только из roles/ — manifest их не несёт
 * (zod-схема манифеста знает только `default_state` без алиасов).
 */
interface ResolvedIdentity {
  role: string;
  email: string;
  default_state: string;
  state_aliases: string[];
}

function resolveIdentities(source: IdentitiesSource, manifest: Manifest): ResolvedIdentity[] {
  if (source.kind === 'roles') {
    return source.roles.map((r) => ({
      role: r.role,
      email: r.email,
      default_state: r.default_state,
      state_aliases: r.state_aliases,
    }));
  }
  return manifest.identities.map((i) => ({
    role: i.role,
    email: i.email,
    default_state: i.default_state,
    // Manifest legacy не несёт алиасов — пустой список. Это нормально:
    // claim_issue резолвит default_state точным совпадением, и для
    // дефолтной слонк-инсталляции имена колонок совпадают с манифестом.
    state_aliases: [],
  }));
}

async function ensureIdentities(args: {
  plane: PlaneClient;
  store: IdentityStore;
  logger: Logger;
  manifest: Manifest;
  source: IdentitiesSource;
  desiredMode: IdentityMode;
}): Promise<BootstrapReport['identities']> {
  const { plane, store, logger, manifest, source, desiredMode } = args;
  const identities = resolveIdentities(source, manifest);
  const sourceTag: 'roles' | 'manifest' = source.kind;

  if (desiredMode === 'single_bot') {
    return await recordSingleBot(store, identities, sourceTag, undefined);
  }

  // per_user: достаём текущих членов workspace, ищем по email; чего нет —
  // инвайтим. Любая ошибка инвайта переключает на single_bot fallback.
  let members;
  try {
    members = await plane.listWorkspaceMembers(manifest.workspace.slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'cannot list workspace members; falling back to single_bot');
    return await recordSingleBot(store, identities, sourceTag, msg);
  }
  const byEmail = new Map(members.map((m) => [m.email, m]));

  let invited = 0;
  let skipped = 0;
  for (const ident of identities) {
    const existing = byEmail.get(ident.email);
    if (existing !== undefined) {
      store.upsert({
        role: ident.role,
        email: ident.email,
        plane_user_id: existing.id,
        mode: 'per_user',
        default_state: ident.default_state,
        state_aliases: ident.state_aliases,
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
        default_state: ident.default_state,
        state_aliases: ident.state_aliases,
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
      return await recordSingleBot(store, identities, sourceTag, msg);
    }
  }
  store.setMeta('identity_mode', 'per_user');
  return { mode: 'per_user', invited, skipped, source: sourceTag };
}

async function recordSingleBot(
  store: IdentityStore,
  identities: ResolvedIdentity[],
  sourceTag: 'roles' | 'manifest',
  reason: string | undefined,
): Promise<BootstrapReport['identities']> {
  for (const ident of identities) {
    store.upsert({
      role: ident.role,
      email: ident.email,
      plane_user_id: null,
      mode: 'single_bot',
      default_state: ident.default_state,
      state_aliases: ident.state_aliases,
    });
  }
  store.setMeta('identity_mode', 'single_bot');
  return {
    mode: 'single_bot',
    invited: 0,
    skipped: identities.length,
    source: sourceTag,
    ...(reason !== undefined ? { fallback_reason: reason } : {}),
  };
}

// Re-export для тестов / CLI диагностики.
export { PlaneError };
