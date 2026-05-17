import { z } from 'zod';

const csvList = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean));

/**
 * Опциональная строка с min(1). Принимает undefined ИЛИ пустую строку как
 * «не задано» (compose часто пробрасывает ${VAR:-} как ""), что zod
 * .optional() сам не покрывает.
 */
const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v))
  .pipe(z.string().min(1).optional());

const Bool01 = z
  .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false'), z.boolean()])
  .transform((v) => v === true || v === '1' || v === 'true');

const PositiveInt = z.coerce.number().int().positive();
const NonNegativeInt = z.coerce.number().int().nonnegative();

const ConfigSchema = z.object({
  // Сервер
  MCP_SERVER_PORT: PositiveInt.default(8787),
  MCP_AUTH_TOKEN: z
    .string()
    .min(32, 'MCP_AUTH_TOKEN must be at least 32 chars of entropy')
    .refine((v) => v !== 'change_me', 'MCP_AUTH_TOKEN must be replaced (default forbidden)'),

  // Plane
  PLANE_API_BASE_URL: z.string().url(),
  PLANE_API_KEY: optionalNonEmpty,

  // MinIO (для attach_file presign и read_attachment, SLONK-14)
  MINIO_BUCKET_MCP: z.string().min(1).default('mcp-artifacts'),
  MINIO_BUCKET_PLANE: z.string().min(1).default('plane-uploads'),
  MINIO_INTERNAL_ENDPOINT: z.string().url().default('http://minio:9000'),
  // Опциональный public endpoint для presigned URL'ов, видимых снаружи
  // docker-сети. Если не задан — используется INTERNAL.
  MINIO_PUBLIC_ENDPOINT: optionalNonEmpty.pipe(z.string().url().optional()),
  // Service-account creds для MinIO. В v1 — те же root-creds, что у Plane;
  // в Phase 7 (TLS) разделим на read-only policy + separate keys.
  MINIO_ACCESS_KEY: optionalNonEmpty,
  MINIO_SECRET_KEY: optionalNonEmpty,
  MINIO_USE_SSL: Bool01.default(false),
  PLANE_SIGNED_URL_EXPIRATION: PositiveInt.default(3600),

  // Бизнес-логика
  MCP_DEFAULT_WORKSPACE: z.string().min(1).default('agents'),
  // Проект адресуется по Plane-идентификатору (короткий код в ключах issue:
  // SLONK-1, SLONK-2, ...). У Plane-проектов нет отдельного «slug», поэтому
  // resolveProject матчит ref по identifier/name/id — дефолт = identifier.
  MCP_DEFAULT_PROJECT: z.string().min(1).default('SLONK'),
  // zod v4: default() требует значение post-transform (string[]), а
  // prefault() — pre-transform (исходную строку, которая прогонится через
  // .transform). Используем prefault, чтобы дефолт парсился теми же
  // правилами, что и значение из env.
  MCP_ALLOWED_PROJECTS: csvList.prefault('SLONK'),
  MCP_AGENT_IDENTITY_MODE: z.enum(['per_user', 'single_bot']).default('per_user'),
  MCP_OPTIONAL_WORKSPACES: Bool01.default(false),

  // Логирование
  MCP_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MCP_LOG_FILE: optionalNonEmpty,

  // Rate limit / retry / timeouts (зарезервированы под Phase 4+, но проверяем форму)
  MCP_RL_GLOBAL_RPS: PositiveInt.default(20),
  MCP_RL_IDENTITY_RPS: PositiveInt.default(5),
  MCP_ALLOW_CIDR: z.string().default('0.0.0.0/0'),
  MCP_RETRY_ATTEMPTS: NonNegativeInt.default(3),
  // 429 — не отказ Plane, а просьба подождать (по умолчанию
  // PLANE_API_KEY_RATE_LIMIT=60/minute). Bootstrap нескольких проектов
  // легко выедает 130+ write-вызовов и упирается в лимит, поэтому для 429
  // держим отдельный, более щедрый retry-budget с уважением Retry-After.
  MCP_RETRY_ATTEMPTS_429: NonNegativeInt.default(10),
  MCP_RETRY_BACKOFF_MS: NonNegativeInt.default(200),
  MCP_PLANE_TIMEOUT_MS: PositiveInt.default(10_000),
  MCP_METRICS_ENABLED: Bool01.default(false),

  // Roles directory (SLONK-6). По умолчанию — undefined: loader сам ищет
  // `roles/` рядом с package.json. Переопределяется, если оператор смонтировал
  // директорию в нестандартное место.
  MCP_ROLES_DIR: optionalNonEmpty,

  // Путь до identity SQLite (SLONK-11). По умолчанию — undefined; в контейнере
  // bootstrap-CLI падает на `BOOTSTRAP_STORE_DEFAULT_PATH` (`/mcp_data/identity.sqlite`),
  // а с хоста (`make smoke-roles`, ручной `pnpm tsx`) Makefile проставляет
  // путь до bind/cp-копии (например, `$(CURDIR)/mcp_data/identity.sqlite`).
  // Loader не выставляет дефолт сам, чтобы in-container bootstrap без ENV
  // продолжал работать с исторической константой.
  MCP_IDENTITY_STORE_PATH: optionalNonEmpty,

  // Memory bounds (SLONK-5). Дефолты подобраны под хост 2 GB RAM, чтобы
  // mcp-kanban не вытеснял Plane в swap при долгой работе агентов.
  // TtlCache: FIFO-cap, защищает от безграничного роста по уникальным
  // ключам (типичный сценарий — `get_issue` с разными issue-ref'ами).
  MCP_CACHE_MAX_ENTRIES: PositiveInt.default(2048),
  // MCP-сессии: idle-timeout + жёсткий cap. Если клиент уронился без
  // graceful shutdown — сессия живёт здесь до janitor'а. 30 минут —
  // запас, чтобы интерактивная работа агента в `/loop` не отвалилась.
  MCP_SESSION_IDLE_MS: PositiveInt.default(30 * 60 * 1000),
  // 0 отключает периодический janitor (для тестов и одноразовых CLI).
  MCP_SESSION_GC_INTERVAL_MS: NonNegativeInt.default(60 * 1000),
  MCP_MAX_SESSIONS: PositiveInt.default(256),

  // Метаданные процесса
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid MCP configuration:\n${issues}`);
  }
  return result.data;
}
