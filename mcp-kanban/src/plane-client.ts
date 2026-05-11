import type { Logger } from 'pino';
import type { Config } from './config.js';

// В Phase 2 Plane-клиент сведён к минимуму: проверка здоровья. Полная
// обёртка над REST API добавляется в Phase 3 (bootstrap) и Phase 4
// (read-only tools).

export interface PlaneHealth {
  reachable: boolean;
  status: number | null;
  latencyMs: number | null;
  error?: string;
}

export class PlaneClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(opts: {
    config: Pick<Config, 'PLANE_API_BASE_URL' | 'PLANE_API_KEY' | 'MCP_PLANE_TIMEOUT_MS'>;
    logger: Logger;
  }) {
    this.baseUrl = new URL(opts.config.PLANE_API_BASE_URL);
    this.apiKey = opts.config.PLANE_API_KEY;
    this.timeoutMs = opts.config.MCP_PLANE_TIMEOUT_MS;
    this.log = opts.logger.child({ component: 'plane-client' });
  }

  async checkHealth(): Promise<PlaneHealth> {
    // upstream Plane v1.3.0 не отдаёт /api/v1/health; работающий эндпоинт —
    // корень `/` (отвечает 200 c {status: "OK"}). PLANE_API_BASE_URL у нас
    // указывает на /api/v1 — поднимаемся на корень, чтобы попасть на /.
    const root = new URL('/', this.baseUrl);
    const t0 = performance.now();
    try {
      const resp = await fetch(root, {
        method: 'GET',
        headers: this.apiKey !== undefined ? { 'X-Api-Key': this.apiKey } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = Math.round(performance.now() - t0);
      return {
        reachable: resp.ok,
        status: resp.status,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: msg, latencyMs }, 'Plane health probe failed');
      return {
        reachable: false,
        status: null,
        latencyMs,
        error: msg,
      };
    }
  }
}
