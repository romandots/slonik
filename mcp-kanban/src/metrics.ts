import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Prometheus метрики (SPEC §12). Single registry, чтобы default-metrics
// (process_*, nodejs_*) и наши кастомные жили вместе. Регистрация —
// один раз при создании MetricsRegistry; повторные конструкторы
// (в тестах) получают свой изолированный регистр.

export class MetricsRegistry {
  readonly registry: Registry;
  readonly toolCalls: Counter<string>;
  readonly toolDuration: Histogram<string>;
  readonly planeErrors: Counter<string>;
  readonly rateLimited: Counter<string>;
  // SLONK-5: memory-bound metrics. Cache size — gauge с pull-источником
  // (collect()), эвикции — counter'ы по причине. Сессии — gauge на текущее
  // число, counter — на причины эвикции.
  readonly cacheSize: Gauge<string>;
  readonly cacheEvictions: Counter<string>;
  readonly sessionsActive: Gauge<string>;
  readonly sessionsEvicted: Counter<string>;

  constructor() {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: 'mcp-kanban' });
    collectDefaultMetrics({ register: this.registry });

    this.toolCalls = new Counter({
      name: 'mcp_tool_calls_total',
      help: 'Total number of MCP tool invocations.',
      labelNames: ['tool', 'outcome', 'error_code'] as const,
      registers: [this.registry],
    });

    this.toolDuration = new Histogram({
      name: 'mcp_tool_duration_seconds',
      help: 'Duration of MCP tool handlers (seconds).',
      labelNames: ['tool', 'outcome'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.planeErrors = new Counter({
      name: 'mcp_plane_errors_total',
      help: 'Plane API errors observed by the MCP client.',
      labelNames: ['kind'] as const,
      registers: [this.registry],
    });

    this.rateLimited = new Counter({
      name: 'mcp_rate_limited_total',
      help: 'Rate-limit rejections.',
      labelNames: ['scope', 'identity'] as const,
      registers: [this.registry],
    });

    this.cacheSize = new Gauge({
      name: 'mcp_cache_size',
      help: 'Current number of keys in the in-memory TtlCache (SLONK-5).',
      registers: [this.registry],
    });

    this.cacheEvictions = new Counter({
      name: 'mcp_cache_evictions_total',
      help: 'Cache evictions by reason (SLONK-5).',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    this.sessionsActive = new Gauge({
      name: 'mcp_active_sessions',
      help: 'Current number of active MCP sessions (SLONK-5).',
      registers: [this.registry],
    });

    this.sessionsEvicted = new Counter({
      name: 'mcp_sessions_evicted_total',
      help: 'MCP session evictions by reason (SLONK-5).',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });
  }

  /** Записать одно tool-выполнение. */
  recordTool(args: {
    tool: string;
    outcome: 'success' | 'error';
    durationSec: number;
    errorCode?: string | null;
  }): void {
    this.toolCalls.inc({
      tool: args.tool,
      outcome: args.outcome,
      error_code: args.errorCode ?? '',
    });
    this.toolDuration.observe({ tool: args.tool, outcome: args.outcome }, args.durationSec);
  }

  recordPlaneError(kind: 'timeout' | '4xx' | '5xx' | 'network' | 'other'): void {
    this.planeErrors.inc({ kind });
  }

  recordRateLimited(scope: 'global' | 'identity', identity: string): void {
    this.rateLimited.inc({ scope, identity });
  }

  async metricsText(): Promise<string> {
    return await this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}

/** Глобальный singleton по умолчанию (для production). Тесты создают свой. */
let defaultRegistry: MetricsRegistry | undefined;
export function getDefaultMetrics(): MetricsRegistry {
  if (defaultRegistry === undefined) defaultRegistry = new MetricsRegistry();
  return defaultRegistry;
}

/** Тест-only: сброс singleton'а, чтобы счётчики начинались с нуля. */
export function resetDefaultMetricsForTests(): void {
  defaultRegistry = undefined;
}
