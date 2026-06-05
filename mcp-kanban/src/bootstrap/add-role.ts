import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { RoleDefinitionSchema, type RoleDefinition } from './roles.js';

// SLONK-12: интерактивная CLI для добавления новой кастомной agent-роли.
// Команда задаёт оператору ровно те поля, что валидирует
// `RoleDefinitionSchema` (см. roles.ts), генерирует markdown-файл с YAML
// front-matter и кладёт его в `roles/` (по умолчанию — та же директория,
// что читает bootstrap). Сам bootstrap затем подхватит файл и заинвайтит
// нового пользователя в Plane на следующем `make bootstrap`.
//
// Сценарии вызова:
//   node dist/server.js add-role
//     — полностью интерактивный режим: задаёт вопросы по очереди.
//   node dist/server.js add-role --role release-agent --email r@x.local \
//     --first-name Release --last-name Agent --default-state Releasing \
//     --state-alias Релиз --state-alias Shipping
//     — non-interactive: все обязательные поля переданы флагами; команда
//       не задаёт вопросов и не требует TTY (для CI / скриптов).
//
// Файл, отношение к git и взаимодействие с bootstrap'ом — см.
// roles/README.md. Команда НЕ зовёт `make bootstrap` сама — это явное
// разделение «положить файл» vs «применить к Plane» (последнее требует
// PLANE_API_KEY и не должно случаться неожиданно при правке роли).

export interface AddRoleCliOptions {
  /** Где лежит roles/. По умолчанию — config.MCP_ROLES_DIR или ./roles. */
  dir?: string;
  /** Источник ответов (для тестов / non-interactive). */
  input?: NodeJS.ReadableStream;
  /** Куда писать prompt'ы и сообщения. По умолчанию — process.stdout. */
  output?: NodeJS.WritableStream;
  /** Полностью готовая роль — пропускает интерактив; используется тестами и --flag-режимом. */
  prefill?: Partial<RoleDefinition>;
  /** Перезаписать существующий файл (по умолчанию — отказ). */
  force?: boolean;
  /** argv-флаги (включая `add-role` или без — функция сама разберётся). */
  argv?: readonly string[];
}

export interface AddRoleResult {
  /** Абсолютный путь до созданного файла. */
  path: string;
  /** Валидированное определение роли (то, что записано в front-matter). */
  role: RoleDefinition;
}

/**
 * Главный entrypoint CLI. Возвращает результат, чтобы тесты могли
 * проверить путь/содержимое; реальный CLI игнорирует возврат и печатает
 * человеку короткое summary.
 */
export async function addRoleCli(opts: AddRoleCliOptions = {}): Promise<AddRoleResult> {
  const output = opts.output ?? defaultStdout;
  // Resolve `roles/` dir:
  //   1. --dir <path> в argv
  //   2. opts.dir (из тестов / программного вызова)
  //   3. MCP_ROLES_DIR из env (через loadConfig — будет валидирован)
  //   4. дефолт: <repo>/roles (тот же, что и loadRoles)
  const parsedArgs = parseArgs(opts.argv ?? []);
  const dirFromArgs = parsedArgs.dir;
  const dirFromEnv = safeLoadRolesDirFromEnv();
  const dir = resolve(
    dirFromArgs ?? opts.dir ?? dirFromEnv ?? defaultRolesDir(),
  );

  ensureWritableDir(dir);

  const prefill: Partial<RoleDefinition> = {
    ...(opts.prefill ?? {}),
    ...parsedArgs.role,
  };

  // Определяем, нужен ли интерактив. Если все обязательные поля уже
  // переданы (флагами или prefill'ом) — пропускаем readline и не требуем
  // TTY. Иначе спрашиваем недостающее у пользователя.
  const interactive = !hasAllRequiredFields(prefill);

  let collected: Record<string, unknown>;
  if (interactive) {
    const input = opts.input ?? defaultStdin;
    const rl = createInterface({ input, output, terminal: false });
    const asker = makeAsker(rl, output);
    try {
      collected = await promptAll(asker, output, prefill);
    } finally {
      rl.close();
    }
  } else {
    collected = {
      role: prefill.role,
      email: prefill.email,
      first_name: prefill.first_name,
      last_name: prefill.last_name,
      default_state: prefill.default_state,
      state_aliases: prefill.state_aliases ?? [],
    };
  }

  const role = RoleDefinitionSchema.parse(collected);

  const filePath = join(dir, `${role.role}.md`);
  const force = parsedArgs.force || opts.force === true;
  if (existsSync(filePath) && !force) {
    throw new Error(
      `Role file already exists: ${filePath}\n` +
        '  Use --force to overwrite, or pick a different `role:` name.\n' +
        '  Tip: each role lives in exactly one *.md (filename = `<role>.md`).',
    );
  }

  writeFileSync(filePath, renderRoleMarkdown(role), 'utf8');

  writeLine(output, '');
  writeLine(output, `Wrote role file: ${filePath}`);
  writeLine(output, `  role:          ${role.role}`);
  writeLine(output, `  email:         ${role.email}`);
  writeLine(output, `  default_state: ${role.default_state}`);
  if (role.state_aliases.length > 0) {
    writeLine(output, `  state_aliases: ${role.state_aliases.join(', ')}`);
  }
  writeLine(output, '');
  writeLine(
    output,
    'Next step: run `make bootstrap` to invite the new agent into Plane and ' +
      'register it in mcp_data/identity.sqlite.',
  );

  return { path: filePath, role };
}

// ---------------- interactive prompting ----------------

const HINT = {
  role:
    'agent identity (lowercase + dashes, e.g. "release-agent"). MCP-сервер ' +
    'будет принимать заголовок `X-Agent-Identity: <role>` после следующего bootstrap.',
  email:
    'почта для приглашения в Plane workspace. Не обязана существовать — ' +
    'локальные домены типа `release-agent@slonk.local` ок.',
  first_name: 'имя пользователя в Plane (для UI).',
  last_name: 'фамилия пользователя в Plane (для UI).',
  default_state:
    'каноническая колонка канбана, куда `claim_issue` для этой роли по ' +
    'умолчанию двигает задачу (e.g. "Development", "Code Review").',
  state_aliases:
    'опциональные синонимы default_state на других языках или для переименованных ' +
    'колонок Plane. Через запятую. Пустая строка — нет алиасов.',
};

/**
 * Возвращает функцию `ask(prompt)`, которая выводит prompt в output и
 * резолвится первой полной строкой из input. Использует
 * собственный line-queue/waiter вместо `readline/promises#question`,
 * потому что у последнего есть известная проблема с `terminal: false`
 * стримами: после первой `question()` следующие зависают, т.к. readline
 * читает все буферизованные строки сразу, но раздаёт только первой
 * подписке (node ≥ 22.11, подтверждено вручную). Event-listener на
 * `line` доставляет каждую строку ровно одному ожидающему — поведение
 * детерминированное и тестируемое через PassThrough.
 */
type Asker = (prompt: string) => Promise<string>;

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
    // Будим всех ожидающих, пусть упадут с ошибкой, а не висят навсегда.
    while (waiters.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const w = waiters.shift()!;
      // resolve пустой строкой и пусть валидатор вверху увидит EOF в
      // следующем тике через флаг closed.
      w('');
    }
  });

  return async (prompt: string): Promise<string> => {
    output.write(prompt);
    if (queue.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
  prefill: Partial<RoleDefinition>,
): Promise<Record<string, unknown>> {
  writeLine(output, 'Adding a new agent role to roles/. Press Ctrl+C to abort.');
  writeLine(output, '');

  // Поле за полем: показываем подсказку (только если значение ещё не
  // задано), валидируем сразу и просим перевводить при ошибке. Это
  // дешевле, чем собрать всё, упасть на zod и заставить юзера начать
  // заново.
  const role = await askValidated(
    ask,
    output,
    'role',
    prefill.role,
    HINT.role,
    (v) =>
      z
        .string()
        .min(1)
        .regex(
          /^[a-z][a-z0-9-]*$/,
          'role must be lowercase with dashes (e.g. "developer-agent")',
        )
        .parse(v),
  );
  const email = await askValidated(
    ask,
    output,
    'email',
    prefill.email,
    HINT.email,
    (v) => z.string().email().parse(v),
  );
  const first_name = await askValidated(
    ask,
    output,
    'first_name',
    prefill.first_name,
    HINT.first_name,
    (v) => z.string().min(1).parse(v),
  );
  const last_name = await askValidated(
    ask,
    output,
    'last_name',
    prefill.last_name,
    HINT.last_name,
    (v) => z.string().min(1).parse(v),
  );
  const default_state = await askValidated(
    ask,
    output,
    'default_state',
    prefill.default_state,
    HINT.default_state,
    (v) => z.string().min(1).parse(v),
  );
  const state_aliases = await askAliases(
    ask,
    output,
    prefill.state_aliases,
  );

  return { role, email, first_name, last_name, default_state, state_aliases };
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
    // Поле уже задано (флагом / prefill'ом) — валидируем без вопроса,
    // но всё равно прогоняем через parser, чтобы упасть на этом шаге, а
    // не в финальной schema.parse (там сообщение об ошибке агрегированное).
    try {
      return parser(prefill);
    } catch (err) {
      throw new Error(
        `Invalid prefilled value for "${field}": ${prefill}\n  ${formatZodError(err)}`,
      );
    }
  }
  writeLine(output, `# ${field}: ${hint}`);
  // eslint-disable-next-line no-constant-condition
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

async function askAliases(
  ask: Asker,
  output: NodeJS.WritableStream,
  prefill: readonly string[] | undefined,
): Promise<string[]> {
  if (prefill !== undefined) {
    return [...prefill];
  }
  writeLine(output, `# state_aliases: ${HINT.state_aliases}`);
  const raw = (await ask('state_aliases (comma-separated, empty for none): ')).trim();
  if (raw === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------- helpers ----------------

function hasAllRequiredFields(p: Partial<RoleDefinition>): boolean {
  return (
    typeof p.role === 'string' &&
    p.role !== '' &&
    typeof p.email === 'string' &&
    p.email !== '' &&
    typeof p.first_name === 'string' &&
    p.first_name !== '' &&
    typeof p.last_name === 'string' &&
    p.last_name !== '' &&
    typeof p.default_state === 'string' &&
    p.default_state !== ''
  );
}

interface ParsedArgs {
  dir?: string;
  force: boolean;
  role: Partial<RoleDefinition>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  // Принимаем как полную форму (включая `add-role`), так и обрезанную:
  // если первый токен — `add-role`, пропускаем. Дальше — длинные флаги.
  const args = [...argv];
  if (args[0] === 'add-role') args.shift();

  const out: ParsedArgs = { force: false, role: {} };
  const aliases: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`Flag "${a}" requires a value`);
      }
      i++;
      return v;
    };
    switch (a) {
      case '--dir':
        out.dir = next();
        break;
      case '--force':
        out.force = true;
        break;
      case '--role':
        out.role.role = next();
        break;
      case '--email':
        out.role.email = next();
        break;
      case '--first-name':
        out.role.first_name = next();
        break;
      case '--last-name':
        out.role.last_name = next();
        break;
      case '--default-state':
        out.role.default_state = next();
        break;
      case '--state-alias':
        aliases.push(next());
        break;
      case '--help':
      case '-h':
        throw new Error(USAGE);
      default:
        throw new Error(`Unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  if (aliases.length > 0) {
    out.role.state_aliases = aliases;
  }
  return out;
}

const USAGE = `Usage: node dist/server.js add-role [options]

Interactive (no flags) — prompts for every field:
  node dist/server.js add-role

Non-interactive — all required fields via flags:
  node dist/server.js add-role \\
    --role release-agent \\
    --email release-agent@slonk.local \\
    --first-name Release --last-name Agent \\
    --default-state Releasing \\
    --state-alias "Релиз" --state-alias Shipping

Options:
  --role <name>            agent identity (lowercase + dashes), required
  --email <addr>           Plane invite address, required
  --first-name <s>         Plane user first name, required
  --last-name <s>          Plane user last name, required
  --default-state <name>   Canonical kanban column, required
  --state-alias <name>     Alias of default_state (repeatable, optional)
  --dir <path>             roles/ directory (default: MCP_ROLES_DIR or ./roles)
  --force                  overwrite existing <role>.md
  -h, --help               show this help
`;

function renderRoleMarkdown(role: RoleDefinition): string {
  // yaml.stringify даёт детерминированный, идиоматичный YAML. Пустой
  // массив пишем не как `[]`, а отдельной секцией — но только если он
  // не пустой; иначе вообще не пишем поле, чтобы файл не содержал
  // мусорные нулевые блоки.
  const fm: Record<string, unknown> = {
    role: role.role,
    email: role.email,
    first_name: role.first_name,
    last_name: role.last_name,
    default_state: role.default_state,
  };
  if (role.state_aliases.length > 0) {
    fm.state_aliases = role.state_aliases;
  }
  // YAML stringify сам добавит trailing newline у каждой строки.
  const frontMatter = stringifyYaml(fm).trimEnd();
  // Body — минимальный человекочитаемый stub. Bootstrap его игнорирует,
  // но оператор / новый агент должны видеть, что роль делает (или хотя
  // бы плейсхолдер, который они заполнят).
  const body = `# ${role.role}\n\nDescribe what this role does, which column it owns, and where it hands off.\n\n\`default_state\` — \`${role.default_state}\`.\n`;
  return `---\n${frontMatter}\n---\n${body}`;
}

function ensureWritableDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  const s = statSync(dir);
  if (!s.isDirectory()) {
    throw new Error(`Roles path is not a directory: ${dir}`);
  }
}

function defaultRolesDir(): string {
  // Зеркалит logic из roles.ts:defaultRolesDir() — поднимаемся к
  // package.json (dist/bootstrap → dist → root) и берём ./roles.
  // Не импортируем из roles.ts, чтобы не таскать туда экспорт ради CLI.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'roles');
}

function safeLoadRolesDirFromEnv(): string | undefined {
  // loadConfig() требует MCP_AUTH_TOKEN — в локальной CLI его может не
  // быть (оператор создаёт роль на хосте, не в контейнере). Не валим
  // команду из-за этого: ловим ошибку конфига, печатаем дефолт.
  try {
    const cfg = loadConfig();
    return cfg.MCP_ROLES_DIR;
  } catch {
    return undefined;
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
