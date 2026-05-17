/*
 * SLONK-6 smoke-сценарий: проверяет data-driven маппинг «роль → колонка»
 * против ЖИВОГО Plane (а не in-memory фейка).
 *
 * Что делает:
 *   1. Читает конфиг из ENV (как обычный сервер).
 *   2. Открывает IdentityStore (наполняется `make bootstrap`).
 *   3. Создаёт временный issue в DEFAULT_PROJECT через PlaneClient.
 *   4. Для каждой роли с известным `default_state` зовёт `claim_issue`
 *      на этом issue (используя реальную audit-БД во временной директории),
 *      проверяет, что issue реально оказался в колонке `default_state`.
 *   5. Чистит за собой: освобождает claim, удаляет issue.
 *
 * Как запускать:
 *   - Стек поднят (`make up`), bootstrap отработал (`make bootstrap`).
 *   - `cd mcp-kanban && pnpm tsx scripts/smoke-roles-claim.ts`.
 *   - Или из контейнера: `docker compose run --rm mcp-kanban node
 *     dist/scripts/smoke-roles-claim.js` (после `pnpm build`).
 *
 * Вывод — построчный JSON в stdout: один объект на роль + summary.
 * Exit code 0 — все роли OK, 1 — хотя бы одна не прошла.
 *
 * Скрипт намеренно НЕ запускается через `vitest run`, чтобы pnpm test не
 * требовал поднятого Plane. Это отдельный smoke-флоу для оператора /
 * CI с реальным окружением.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { PlaneClient } from '../src/plane-client.js';
import { TtlCache } from '../src/cache.js';
import { AuditLog, newTraceId } from '../src/audit.js';
import { IdentityStore } from '../src/bootstrap/store.js';
import { BOOTSTRAP_STORE_DEFAULT_PATH } from '../src/bootstrap/cli.js';
import { claimIssue } from '../src/tools/claim-issue/handler.js';
import { resolveProject } from '../src/tools/project-resolver.js';

interface RoleResult {
  role: string;
  default_state: string;
  state_aliases: string[];
  outcome: 'ok' | 'failed' | 'skipped';
  observed_state?: string;
  error?: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config).child({ component: 'smoke-roles' });

  if (config.PLANE_API_KEY === undefined) {
    process.stderr.write('PLANE_API_KEY required — smoke needs a live Plane.\n');
    process.exit(2);
  }
  const plane = new PlaneClient({ config, logger });
  const store = new IdentityStore({ path: BOOTSTRAP_STORE_DEFAULT_PATH });
  const tmp = mkdtempSync(join(tmpdir(), 'slonk-smoke-roles-'));
  const audit = new AuditLog({ path: join(tmp, 'audit.sqlite') });
  const cache = new TtlCache();

  const project = await resolveProject({
    plane,
    workspaceSlug: config.MCP_DEFAULT_WORKSPACE,
    defaultProjectRef: config.MCP_DEFAULT_PROJECT,
    allowedProjects: config.MCP_ALLOWED_PROJECTS,
  });
  const states = await plane.listStates(config.MCP_DEFAULT_WORKSPACE, project.id);
  const toDo = states.find((s) => s.name === 'To Do');
  if (toDo === undefined) {
    process.stderr.write(`Project ${project.identifier} has no "To Do" state; aborting smoke.\n`);
    process.exit(2);
  }

  const issue = await plane.createIssue(config.MCP_DEFAULT_WORKSPACE, project.id, {
    name: `[SLONK-6 smoke] roles → claim — ${new Date().toISOString()}`,
    state: toDo.id,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: 'created_test_issue', issue_id: issue.id }));

  const results: RoleResult[] = [];
  try {
    for (const ident of store.all()) {
      const expected = ident.default_state;
      if (expected === null) {
        results.push({
          role: ident.role,
          default_state: '',
          state_aliases: ident.state_aliases,
          outcome: 'skipped',
          error: 'default_state is null in store',
        });
        continue;
      }
      try {
        const r = await claimIssue({
          plane,
          cache,
          audit,
          identityStore: store,
          workspace: config.MCP_DEFAULT_WORKSPACE,
          defaultProjectRef: config.MCP_DEFAULT_PROJECT,
          allowedProjects: config.MCP_ALLOWED_PROJECTS,
          identity: ident.role,
          traceId: newTraceId(),
          planeUserId: ident.plane_user_id,
          input: { issue_id: issue.id },
        });
        const observedState = r.state?.name ?? '';
        const ok =
          observedState === expected ||
          ident.state_aliases.some((a) => a.toLowerCase() === observedState.toLowerCase());
        results.push({
          role: ident.role,
          default_state: expected,
          state_aliases: ident.state_aliases,
          outcome: ok ? 'ok' : 'failed',
          observed_state: observedState,
          ...(ok ? {} : { error: `expected '${expected}' or alias, got '${observedState}'` }),
        });
        // Освобождаем claim в audit, чтобы следующий agent мог взять его.
        audit.releaseClaim({ issue_id: issue.id, identity: ident.role });
        // И возвращаем issue в To Do — иначе следующая роль не сможет
        // отличить переход «claim» от «уже в моей колонке».
        await plane.updateIssue(config.MCP_DEFAULT_WORKSPACE, project.id, issue.id, {
          state: toDo.id,
        });
      } catch (err) {
        results.push({
          role: ident.role,
          default_state: expected,
          state_aliases: ident.state_aliases,
          outcome: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          audit.releaseClaim({ issue_id: issue.id, identity: ident.role });
        } catch {
          // best-effort
        }
      }
    }
  } finally {
    // Cleanup: удаляем issue. Plane v1.3.0 hard-delete по умолчанию идёт
    // через flag, иначе issue будет помечен archived/trashed. Для smoke
    // нам важно не оставлять мусора — но если delete упал, не блокируем
    // выход с правильным exit code'ом.
    try {
      await plane.request<unknown>(
        `/workspaces/${config.MCP_DEFAULT_WORKSPACE}/projects/${project.id}/issues/${issue.id}/`,
        { method: 'DELETE' },
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), issue: issue.id },
        'failed to delete smoke issue — clean it up manually in Plane UI',
      );
    }
    audit.close();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r));
  }
  const failed = results.filter((r) => r.outcome === 'failed').length;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'summary',
      total: results.length,
      ok: results.filter((r) => r.outcome === 'ok').length,
      failed,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
    }),
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`Smoke failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
