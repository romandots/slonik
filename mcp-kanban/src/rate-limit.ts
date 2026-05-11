// Token-bucket rate limiter, in-memory. Один лимит — глобальный, второй —
// per-identity. Превышение → RATE_LIMITED с `retry_after_ms`.

import { McpError } from './errors.js';
import type { AgentIdentity } from './identity.js';

export interface RateLimiterOptions {
  globalRps: number;
  identityRps: number;
  /** Override источника времени для тестов. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly globalRps: number;
  private readonly identityRps: number;
  private readonly now: () => number;
  private readonly global: Bucket;
  private readonly perIdentity = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions) {
    this.globalRps = opts.globalRps;
    this.identityRps = opts.identityRps;
    this.now = opts.now ?? Date.now;
    this.global = { tokens: opts.globalRps, lastRefillMs: this.now() };
  }

  /**
   * Берёт 1 токен из глобального и identity-bucket'а. Бросает RATE_LIMITED
   * (с retry_after_ms в message) при пустом bucket'е.
   */
  consume(identity: AgentIdentity): void {
    const now = this.now();
    this.refill(this.global, this.globalRps, now);
    const id = this.bucketFor(identity, now);
    this.refill(id, this.identityRps, now);

    if (this.global.tokens < 1) {
      throw new McpError({
        code: 'RATE_LIMITED',
        message: `global rate limit exceeded; retry_after_ms=${this.estimateRetry(this.global, this.globalRps)}`,
      });
    }
    if (id.tokens < 1) {
      throw new McpError({
        code: 'RATE_LIMITED',
        message: `identity rate limit exceeded for ${identity}; retry_after_ms=${this.estimateRetry(id, this.identityRps)}`,
      });
    }
    this.global.tokens -= 1;
    id.tokens -= 1;
  }

  /** Тесты: текущее число доступных токенов в identity-bucket. */
  identityTokens(identity: AgentIdentity): number {
    const b = this.perIdentity.get(identity);
    return b?.tokens ?? this.identityRps;
  }

  /** Тесты: текущее число токенов в глобальном bucket'е. */
  globalTokens(): number {
    return this.global.tokens;
  }

  private bucketFor(identity: AgentIdentity, now: number): Bucket {
    let b = this.perIdentity.get(identity);
    if (b === undefined) {
      b = { tokens: this.identityRps, lastRefillMs: now };
      this.perIdentity.set(identity, b);
    }
    return b;
  }

  private refill(b: Bucket, rps: number, now: number): void {
    const dt = now - b.lastRefillMs;
    if (dt <= 0) return;
    const refill = (dt / 1000) * rps;
    if (refill <= 0) return;
    b.tokens = Math.min(rps, b.tokens + refill);
    b.lastRefillMs = now;
  }

  private estimateRetry(b: Bucket, rps: number): number {
    if (b.tokens >= 1) return 0;
    const need = 1 - b.tokens;
    return Math.ceil((need / rps) * 1000);
  }
}
