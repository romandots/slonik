import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { PlaneClient } from '../plane-client.js';
import { loadManifest } from './manifest.js';
import { loadRoles } from './roles.js';
import { IdentityStore } from './store.js';
import { runBootstrap, type BootstrapReport, type IdentitiesSource } from './runner.js';
import { isValidWorkspaceSlug } from '../oauth/defaults.js';

// Entrypoint для `mcp-kanban bootstrap`. Вызывается из server.ts через
// dispatch'ера CLI-аргументов. Выходит с кодом 0 при успехе, 1 при любой
// неустранимой ошибке.

export const BOOTSTRAP_STORE_DEFAULT_PATH = '/mcp_data/identity.sqlite';

export interface BootstrapCliOptions {
  manifestPath?: string;
  storePath?: string;
  /** Путь до директории `roles/`. По умолчанию — рядом с package.json. */
  rolesDir?: string;
  /**
   * SLONK-18 (multitenant): bootstrap'ить workspace тенанта вместо
   * `manifest.workspace.slug`. Когда не задан — поведение прежнее.
   */
  workspaceSlug?: string;
  /**
   * SLONK-18: Plane API-ключ тенанта для этого прогона. Когда не задан —
   * берётся `config.PLANE_API_KEY` из ENV (прежнее поведение).
   */
  planeApiKey?: string;
  /** argv-флаги (с ведущим `bootstrap` или без). Разбираются в workspaceSlug/planeApiKey. */
  argv?: readonly string[];
}

export async function bootstrapCli(opts: BootstrapCliOptions = {}): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config).child({ component: 'bootstrap' });
  const manifest = loadManifest({ ...(opts.manifestPath !== undefined ? { path: opts.manifestPath } : {}) });

  // SLONK-18: CLI-флаги перебивают opts; opts перебивают ENV/манифест.
  const cliArgs = parseBootstrapArgs(opts.argv ?? []);
  const workspaceSlug = cliArgs.workspaceSlug ?? opts.workspaceSlug;
  const planeApiKey = cliArgs.planeApiKey ?? opts.planeApiKey;
  // SLONK-6: primary-источник identities — `roles/`. Если директория
  // пуста / отсутствует, бьём warn и падаем на legacy
  // `manifest.identities` (для инсталляций, обновляющихся с версии без
  // поддержки `roles/`).
  const rolesDir = opts.rolesDir ?? config.MCP_ROLES_DIR;
  // Передаём bootstrap-логгер в loadRoles, чтобы пропуски нерегулярных файлов
  // (symlink / directory / FIFO) попадали в стандартный канал bootstrap'а
  // как warn-строка. См. SLONK-10 — defense-in-depth против symlink-следования.
  const rolesResult = loadRoles({
    ...(rolesDir !== undefined ? { dir: rolesDir } : {}),
    logger,
  });
  const identitiesSource: IdentitiesSource = rolesResult.found
    ? { kind: 'roles', roles: rolesResult.roles }
    : { kind: 'manifest' };
  if (!rolesResult.found) {
    logger.warn(
      { roles_dir: rolesResult.path },
      'roles/ directory empty or missing; falling back to manifest.identities (legacy). ' +
        'Create role *.md files under roles/ for forward-compatible setup.',
    );
  } else {
    logger.info(
      { roles_dir: rolesResult.path, count: rolesResult.roles.length },
      'identities loaded from roles/',
    );
  }

  // SLONK-18: эффективный ключ — флаг/opts (тенант) либо ENV (дефолтный workspace).
  const effectiveApiKey = planeApiKey ?? config.PLANE_API_KEY;
  if (effectiveApiKey === undefined) {
    logger.error(
      'PLANE_API_KEY is not set; bootstrap cannot authenticate against Plane. ' +
        'Generate the key in Plane UI (Settings → API Tokens) and set it in .env, ' +
        'or pass --plane-api-key for a specific tenant workspace.',
    );
    throw new Error('PLANE_API_KEY required for bootstrap');
  }

  // Если ключ переопределён для тенанта — строим PlaneClient с его кредами,
  // не трогая глобальный config (паттерн server.ts:getPlaneClient).
  const plane =
    planeApiKey !== undefined
      ? new PlaneClient({ config: { ...config, PLANE_API_KEY: planeApiKey }, logger })
      : new PlaneClient({ config, logger });
  // SLONK-11: путь до identity SQLite берётся в порядке CLI-флаг → ENV → дефолт.
  // Дефолт `BOOTSTRAP_STORE_DEFAULT_PATH` = `/mcp_data/identity.sqlite` — это
  // контейнерный путь, поэтому in-container `make bootstrap` без ENV работает
  // как раньше. С хоста (smoke-сценарий) ENV `MCP_IDENTITY_STORE_PATH`
  // перебивает дефолт на путь до bind/cp-копии identity-стора.
  const storePath =
    opts.storePath ?? config.MCP_IDENTITY_STORE_PATH ?? BOOTSTRAP_STORE_DEFAULT_PATH;
  const store = new IdentityStore({ path: storePath });
  try {
    const report = await runBootstrap({
      plane,
      store,
      logger,
      manifest,
      identitiesSource,
      config,
      ...(workspaceSlug !== undefined ? { workspaceSlugOverride: workspaceSlug } : {}),
    });
    printReport(report);
    // Resilient-цикл в runBootstrap собирает падения по проектам в
    // report.projects[i].error; сам по себе runBootstrap не throw'ит на
    // частичных сбоях, чтобы дописать identities и отчёт. CLI же сигнализирует
    // оператору ненулевым exit code — иначе CI/`make bootstrap` пройдут зелёными
    // при частично сломанной инициализации.
    const failed = report.projects.filter((p) => p.error !== undefined);
    if (failed.length > 0) {
      throw new Error(
        `bootstrap completed with ${failed.length} failed project(s): ` +
          failed.map((p) => `${p.identifier} (${p.error?.message ?? 'unknown'})`).join('; '),
      );
    }
  } finally {
    store.close();
  }
}

// SLONK-18: разбор multitenant-флагов bootstrap. Принимает как полную форму
// (с ведущим `bootstrap`), так и обрезанную. Неизвестные аргументы — ошибка.
interface BootstrapArgs {
  workspaceSlug?: string;
  planeApiKey?: string;
}

export function parseBootstrapArgs(argv: readonly string[]): BootstrapArgs {
  const args = [...argv];
  if (args[0] === 'bootstrap') args.shift();

  const out: BootstrapArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[i + 1];
      // Пустую строку трактуем как пропущенное значение (операторская ошибка).
      if (v === undefined || v === '' || v.startsWith('--')) {
        throw new Error(`Flag "${a}" requires a non-empty value`);
      }
      i++;
      return v;
    };
    switch (a) {
      case '--workspace': {
        const slug = next();
        // Валидируем slug тем же regex, что add-tenant: lowercase/цифры/дефисы.
        // Помимо чистоты ввода это защита от подстановки `../`-сегментов в URL
        // (path traversal / SSRF к внутреннему Plane API через workspaceSlug).
        if (!isValidWorkspaceSlug(slug)) {
          throw new Error(
            `Invalid workspace slug "${slug}": must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`,
          );
        }
        out.workspaceSlug = slug;
        break;
      }
      case '--plane-api-key':
        out.planeApiKey = next();
        break;
      default:
        throw new Error(
          `Unknown argument: ${a}\n\n` +
            'Usage: node dist/server.js bootstrap [--workspace <slug>] [--plane-api-key <key>]',
        );
    }
  }
  return out;
}

function printReport(report: BootstrapReport): void {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`workspace: ${report.workspace.slug} (${report.workspace.created ? 'created' : 'exists'})`);
  for (const p of report.projects) {
    if (p.error !== undefined) {
      // Сразу заметно глазами: упавшие проекты идут с маркером FAILED + причиной.
      lines.push(`project:   ${p.identifier} / ${p.slug} (FAILED: ${p.error.message})`);
      continue;
    }
    lines.push(`project:   ${p.identifier} / ${p.slug} (${p.created ? 'created' : 'exists'})`);
  }
  lines.push(
    `states:    ${report.states.created} created, ${report.states.renamed} renamed, ` +
      `${report.states.deleted} deleted` +
      (report.states.delete_failed > 0 ? ` (${report.states.delete_failed} delete failed)` : '') +
      `, ${report.states.existing} existing (of ${report.states.total})`,
  );
  lines.push(
    `labels:    ${report.labels.created} created, ${report.labels.existing} existing (of ${report.labels.total})`,
  );
  lines.push(
    `identity:  mode=${report.identities.mode} source=${report.identities.source} invited=${report.identities.invited} skipped=${report.identities.skipped}` +
      (report.identities.fallback_reason !== undefined
        ? ` fallback_reason="${report.identities.fallback_reason}"`
        : ''),
  );
  lines.push(`duration:  ${report.duration_ms} ms`);
  lines.push('BOOTSTRAP OK');

  // Намеренно через console.log: bootstrap — CLI, отчёт идёт в stdout
  // пользователю, не в structured-логи.
   
  console.log(lines.join('\n'));
}
