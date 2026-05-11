import { createHash } from 'node:crypto';

// Простой in-memory TTL-кеш для Plane-ответов. См. ROADMAP Phase 4:
// «Кеш Plane-ответов в памяти на 10 секунд (по tool+input_hash)».
//
// Кеш — process-local, без LRU-эвикции по размеру: набор ключей ограничен
// числом активных tool×input пар на 10-секундном окне.

export interface CacheOptions {
  /** TTL ключа в миллисекундах. */
  ttlMs?: number;
  /** Источник «сейчас» — для детерминированных тестов. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 10_000;

export class TtlCache<T = unknown> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly map = new Map<string, { value: T; expiresAt: number }>();

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Возвращает закешированное значение или undefined (включая истёкшие). */
  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /**
   * Запоминает результат `fn()` под `key` до истечения TTL.
   * Гонок не предотвращает (две параллельных миссы → два вызова fn);
   * для v1 это допустимо — Plane-клиент сам идемпотентен на GET'ах.
   */
  async memoize(key: string, fn: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const fresh = await fn();
    this.set(key, fresh);
    return fresh;
  }

  /** Полностью очищает кеш — для тестов и инвалидации после write-tool'ов. */
  clear(): void {
    this.map.clear();
  }

  /** Удаляет один ключ. */
  delete(key: string): void {
    this.map.delete(key);
  }

  /** Текущий размер (для метрик/тестов). */
  size(): number {
    return this.map.size;
  }
}

/**
 * Стабильный SHA-256 хеш произвольного объекта — для построения cache-ключа
 * (tool + input).
 */
export function inputHash(value: unknown): string {
  const json = stableStringify(value);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return '{' + pairs.join(',') + '}';
}
