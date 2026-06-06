import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { OAuthStore } from '../oauth/store.js';
import { generateOpaqueToken, hashToken } from '../oauth/crypto.js';
import {
  OAUTH_STORE_DEFAULT_PATH,
  DEFAULT_OAUTH_MAX_CLIENTS,
  WORKSPACE_SLUG_RE,
} from '../oauth/defaults.js';

// SLONK-18: operator-CLI для регистрации/обновления тенанта в OAuth-сторе
// (multitenant-режим). Тенант = workspace + собственный Plane API-ключ +
// пароль для OAuth-логина на `/oauth/authorize?workspace=<slug>`. Запись
// идёт в ту же таблицу `tenants` (oauth.sqlite), которую читает рантайм:
//   - server.ts:getPlaneClient(workspace) выбирает per-tenant plane_api_key;
//   - oauth/routes.ts сверяет введённый пароль с tenant.auth_token_hash.
// Пароль хранится ТОЛЬКО как hashToken (SHA-256 hex) — единообразно с тем,
// как регистрируется дефолтный тенант (server.ts) и как сверяется пароль
// (routes.ts:constantTimeEqual(hashToken(password), tenant.auth_token_hash)).
// Изобретать другой алгоритм нельзя — иначе authorize-сверка не пройдёт.
//
// Сценарии вызова (основной — контейнерный, том mcp_data внутри Docker):
//   docker compose run --rm mcp-kanban node dist/server.js add-tenant \
//     --workspace acme --plane-api-key plane_api_xxx --password 'S3cret...'
//     — non-interactive: оба обязательных флага заданы, TTY не нужен (CI).
//   docker compose run --rm -iT mcp-kanban node dist/server.js add-tenant
//     — интерактивный режим: спросит workspace / plane-api-key / password.
//   (хост) ... add-tenant --store ./mcp_data/oauth.sqlite --workspace ...
//     — запуск против bind/cp-копии стора, путь задаётся флагом --store.
//
// Пароль и ключ читаются как обычный input (без скрытого ввода) — это
// локальная операторская консоль, симметрично add-role. Команда НЕ
// бутстрапит Plane-workspace сама: инициализация states/labels/identities
// тенанта — отдельный `make bootstrap --workspace <slug> --plane-api-key ...`.

/** Минимальная длина пароля, заданного оператором вручную (SLONK-18, подтверждено). */
const MIN_PASSWORD_LENGTH = 8;

export interface TenantInput {
  workspace: string;
  plane_api_key: string;
  /** Опционален: если не задан — генерируется CSPRNG-пароль и печатается один раз. */
  password?: string;
  /** Опционален: per-tenant OAuth-client cap; default — config.MCP_OAUTH_MAX_CLIENTS. */
  max_clients?: number;
}

export interface AddTenantCliOptions {
  /** Путь к oauth.sqlite. Default: MCP_OAUTH_STORE_PATH → OAUTH_STORE_DEFAULT_PATH. */
  storePath?: string;
  /** maxClients для OAuthStore-конструктора. Default: config.MCP_OAUTH_MAX_CLIENTS. */
  maxClients?: number;
  /** argv-флаги (с ведущим `add-tenant` или без — функция сама разберётся). */
  argv?: readonly string[];
  /** Источник ответов в интерактивном режиме (для тестов). */
  input?: NodeJS.ReadableStream;
  /** Куда писать prompt'ы и summary. По умолчанию — process.stdout. */
  output?: NodeJS.WritableStream;
  /** Готовые значения — пропускают интерактив; используются тестами и --flag-режимом. */
  prefill?: Partial<TenantInput>;
  /** Готовый OAuthStore (DI для тестов). Если задан — CLI не открывает/не закрывает его сам. */
  store?: OAuthStore;
  /** Override Date.now (для детерминированных тестов). */
  now?: () => number;
}

export interface AddTenantResult {
  workspace: string;
  /** true если тенант создан впервые, false если обновлён существующий. */
  created: boolean;
  /** Сгенерированный пароль — заполнен ТОЛЬКО если оператор не задал свой. */
  generatedPassword?: string;
}

const TenantInputSchema = z.object({
  workspace: z
    .string()
    .min(1, 'workspace is required')
    .regex(
      WORKSPACE_SLUG_RE,
      'workspace must be a slug: lowercase letters, digits and dashes, no leading/trailing dash (e.g. "acme" or "team-1")',
    ),
  plane_api_key: z.string().min(1, 'plane_api_key is required'),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .optional(),
  max_clients: z.coerce.number().int().positive().optional(),
});

/**
 * Главный entrypoint CLI. Возвращает результат, чтобы тесты могли проверить
 * created/generatedPassword; реальный CLI печатает человеку summary и
 * игнорирует возврат. Секреты (plane_api_key, сырой пароль, хэш) НЕ уходят
 * в pino-логи — печать идёт только в output-стрим.
 */
export async function addTenantCli(opts: AddTenantCliOptions = {}): Promise<AddTenantResult> {
  const output = opts.output ?? defaultStdout;
  const now = opts.now ?? (() => Date.now());
  const parsed = parseArgs(opts.argv ?? []);

  const prefill: Partial<TenantInput> = {
    ...(opts.prefill ?? {}),
    ...parsed.input,
  };

  // Non-interactive, если оба обязательных поля уже заданы (флагами / prefill'ом).
  const interactive = !hasRequiredFields(prefill);

  let collected: Record<string, unknown>;
  if (interactive) {
    const input = opts.input ?? defaultStdin;
    const rl = createInterface({ input, output, terminal: false });
    const ask = makeAsker(rl, output);
    try {
      collected = await promptAll(ask, output, prefill);
    } finally {
      rl.close();
    }
  } else {
    collected = {
      workspace: prefill.workspace,
      plane_api_key: prefill.plane_api_key,
      ...(prefill.password !== undefined ? { password: prefill.password } : {}),
      ...(prefill.max_clients !== undefined ? { max_clients: prefill.max_clients } : {}),
    };
  }

  const tenant = TenantInputSchema.parse(collected);

  // Пароль: если не задан — генерируем CSPRNG-токен (43 символа base64url),
  // печатаем ровно один раз. Если задан — обратно НЕ печатаем.
  const generatedPassword = tenant.password === undefined ? generateOpaqueToken() : undefined;
  const effectivePassword = tenant.password ?? generatedPassword!;

  const envDefaults = safeLoadEnvDefaults();
  const storePath =
    parsed.storePath ?? opts.storePath ?? envDefaults.storePath ?? OAUTH_STORE_DEFAULT_PATH;
  const maxClients = opts.maxClients ?? envDefaults.maxClients ?? DEFAULT_OAUTH_MAX_CLIENTS;

  const ownStore = opts.store === undefined;
  const store = opts.store ?? new OAuthStore({ path: storePath, maxClients });
  try {
    const created = store.getTenantByWorkspace(tenant.workspace) === undefined;
    // created_at_ms используется только при INSERT нового тенанта: registerTenant
    // делает ON CONFLICT DO UPDATE без него, поэтому при update метка остаётся
    // исходной, а переданный now() тихо игнорируется SQL'ом (см. store.ts).
    store.registerTenant({
      workspace: tenant.workspace,
      plane_api_key: tenant.plane_api_key,
      auth_token_hash: hashToken(effectivePassword),
      ...(tenant.max_clients !== undefined ? { max_clients: tenant.max_clients } : {}),
      created_at_ms: now(),
    });

    printSummary(output, {
      workspace: tenant.workspace,
      created,
      storePath: ownStore ? storePath : '(injected store)',
      ...(generatedPassword !== undefined ? { generatedPassword } : {}),
    });

    return {
      workspace: tenant.workspace,
      created,
      ...(generatedPassword !== undefined ? { generatedPassword } : {}),
    };
  } finally {
    if (ownStore) store.close();
  }
}

// ---------------- summary ----------------

function printSummary(
  output: NodeJS.WritableStream,
  args: { workspace: string; created: boolean; storePath: string; generatedPassword?: string },
): void {
  writeLine(output, '');
  writeLine(output, `Tenant ${args.created ? 'registered' : 'updated'}: ${args.workspace}`);
  writeLine(output, `  store:        ${args.storePath}`);
  writeLine(output, '  plane_api_key: recorded (not echoed)');
  if (args.generatedPassword !== undefined) {
    writeLine(output, '');
    writeLine(output, '  Generated password (store it now — shown once, never again):');
    writeLine(output, `    ${args.generatedPassword}`);
  }
  writeLine(output, '');
  writeLine(
    output,
    `Next: initialise this workspace in Plane (create it in the UI, issue its API key), then run:`,
  );
  writeLine(
    output,
    `  make bootstrap ARGS="--workspace ${args.workspace} --plane-api-key <key>"`,
  );
  writeLine(
    output,
    'Note: changing an existing tenant API key needs an mcp-kanban restart ' +
      '(per-workspace PlaneClient is cached): docker compose up -d mcp-kanban',
  );
}

// ---------------- interactive prompting ----------------

const HINT = {
  workspace:
    'slug Plane-workspace тенанта (lowercase + дефисы, e.g. "acme"). Граница ' +
    'изоляции: агент видит только проекты этого workspace.',
  plane_api_key:
    'workspace-scoped Plane API-ключ ЭТОГО workspace (Plane UI → Workspace ' +
    'settings → API tokens). Не echo-ится обратно.',
  password:
    'пароль для /oauth/authorize?workspace=<slug> (≥8 символов). Пустая ' +
    'строка — сгенерировать случайный и показать один раз.',
};

type Asker = (prompt: string) => Promise<string>;

/**
 * Line-queue asker: доставляет каждую входную строку ровно одному ожидающему.
 * Тот же приём, что в add-role.ts — readline/promises#question зависает на
 * `terminal: false` стримах при втором вопросе (node ≥ 22.11). Реализация
 * детерминированна и тестируется через PassThrough.
 */
function makeAsker(rl: ReadlineInterface, output: NodeJS.WritableStream): Asker {
  const queue: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  let closeErr: Error | undefined;

  rl.on('line', (line: string) => {
    const w = waiters.shift();
    if (w !== undefined) w(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    closeErr = new Error('input stream closed before all answers collected');
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w('');
    }
  });

  return async (prompt: string): Promise<string> => {
    output.write(prompt);
    if (queue.length > 0) {
      return queue.shift()!;
    }
    if (closed) {
      throw closeErr ?? new Error('input stream closed');
    }
    return await new Promise<string>((resolve) => {
      waiters.push(resolve);
    });
  };
}

async function promptAll(
  ask: Asker,
  output: NodeJS.WritableStream,
  prefill: Partial<TenantInput>,
): Promise<Record<string, unknown>> {
  writeLine(output, 'Registering a tenant in the OAuth store. Press Ctrl+C to abort.');
  writeLine(output, '');

  const workspace = await askValidated(
    ask,
    output,
    'workspace',
    prefill.workspace,
    HINT.workspace,
    (v) => TenantInputSchema.shape.workspace.parse(v),
  );
  const plane_api_key = await askValidated(
    ask,
    output,
    'plane_api_key',
    prefill.plane_api_key,
    HINT.plane_api_key,
    (v) => z.string().min(1).parse(v),
  );
  const password = await askPassword(ask, output, prefill.password);

  return {
    workspace,
    plane_api_key,
    ...(password !== undefined ? { password } : {}),
    ...(prefill.max_clients !== undefined ? { max_clients: prefill.max_clients } : {}),
  };
}

async function askValidated<T>(
  ask: Asker,
  output: NodeJS.WritableStream,
  field: string,
  prefill: string | undefined,
  hint: string,
  parser: (raw: string) => T,
): Promise<T> {
  if (prefill !== undefined && prefill !== '') {
    try {
      return parser(prefill);
    } catch (err) {
      throw new Error(
        `Invalid prefilled value for "${field}": ${formatZodError(err)}`,
      );
    }
  }
  writeLine(output, `# ${field}: ${hint}`);
  while (true) {
    const raw = (await ask(`${field}: `)).trim();
    if (raw === '') {
      writeLine(output, '  (required, please enter a value)');
      continue;
    }
    try {
      return parser(raw);
    } catch (err) {
      writeLine(output, `  ${formatZodError(err)}`);
    }
  }
}

/** Пароль необязателен: пустой ввод → undefined (генерация на верхнем уровне). */
async function askPassword(
  ask: Asker,
  output: NodeJS.WritableStream,
  prefill: string | undefined,
): Promise<string | undefined> {
  if (prefill !== undefined && prefill !== '') {
    return TenantInputSchema.shape.password.parse(prefill);
  }
  writeLine(output, `# password: ${HINT.password}`);
  while (true) {
    const raw = (await ask('password (empty = generate): ')).trim();
    if (raw === '') return undefined;
    try {
      return TenantInputSchema.shape.password.parse(raw);
    } catch (err) {
      writeLine(output, `  ${formatZodError(err)}`);
    }
  }
}

// ---------------- arg parsing ----------------

interface ParsedArgs {
  storePath?: string;
  input: Partial<TenantInput>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  if (args[0] === 'add-tenant') args.shift();

  const out: ParsedArgs = { input: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[i + 1];
      // Пустую строку трактуем как пропущенное значение: `--plane-api-key ''`
      // — операторская ошибка, а не запрос интерактива.
      if (v === undefined || v === '' || v.startsWith('--')) {
        throw new Error(`Flag "${a}" requires a non-empty value`);
      }
      i++;
      return v;
    };
    switch (a) {
      case '--workspace':
        out.input.workspace = next();
        break;
      case '--plane-api-key':
        out.input.plane_api_key = next();
        break;
      case '--password':
        out.input.password = next();
        break;
      case '--max-clients':
        out.input.max_clients = Number(next());
        break;
      case '--store':
        out.storePath = next();
        break;
      case '--help':
      case '-h':
        throw new Error(USAGE);
      default:
        throw new Error(`Unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  return out;
}

const USAGE = `Usage: node dist/server.js add-tenant [options]

Register or update a tenant (workspace + Plane API key + OAuth login password)
in the OAuth store (oauth.sqlite). Idempotent: re-running with the same
--workspace updates the API key / password in place.

Interactive (omit --workspace or --plane-api-key) — prompts for missing fields:
  docker compose run --rm -iT mcp-kanban node dist/server.js add-tenant

Non-interactive — both required flags given:
  docker compose run --rm mcp-kanban node dist/server.js add-tenant \\
    --workspace acme --plane-api-key plane_api_xxx --password 'S3cret-pass'

Options:
  --workspace <slug>       tenant Plane workspace slug (required)
  --plane-api-key <key>    workspace-scoped Plane API key (required)
  --password <pass>        OAuth login password (>=8 chars). Omit to generate.
  --max-clients <n>        per-tenant OAuth client cap (default MCP_OAUTH_MAX_CLIENTS)
  --store <path>           path to oauth.sqlite (default /mcp_data/oauth.sqlite)
  -h, --help               show this help

Note: secrets passed via --plane-api-key / --password stay in shell history
and \`ps\` output. Prefer the interactive mode (omit them) on shared hosts. A
generated password is printed once and also lands in container stdout/logs.
`;

// ---------------- helpers ----------------

function hasRequiredFields(p: Partial<TenantInput>): boolean {
  return (
    typeof p.workspace === 'string' &&
    p.workspace !== '' &&
    typeof p.plane_api_key === 'string' &&
    p.plane_api_key !== ''
  );
}

function safeLoadEnvDefaults(): { storePath: string | undefined; maxClients: number | undefined } {
  // loadConfig() требует MCP_AUTH_TOKEN — на хосте его может не быть. Не валим
  // команду из-за этого: ловим ошибку и используем дефолты / флаги. Один вызов
  // loadConfig — оба значения берём из одного снимка конфига.
  try {
    const cfg = loadConfig();
    return { storePath: cfg.MCP_OAUTH_STORE_PATH, maxClients: cfg.MCP_OAUTH_MAX_CLIENTS };
  } catch {
    return { storePath: undefined, maxClients: undefined };
  }
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

function formatZodError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => i.message).join('; ');
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
