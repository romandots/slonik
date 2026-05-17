import { createHash } from 'node:crypto';

// Простой in-memory TTL-кеш для Plane-ответов. См. ROADMAP Phase 4:
// «Кеш Plane-ответов в памяти на 10 секунд (по tool+input_hash)».
//
// Кеш — process-local. Эвикция:
//   - по TTL: лениво в `get()` (записи живут до запроса),
//             и активно в `set()` (sweep устаревших ключей раз в `gcEvery` set'ов).
//   - по размеру: FIFO-cap `maxEntries`. JS `Map` сохраняет insertion order,
//     поэтому при переполнении вытесняется ключ с самой ранней вставкой.
//
// FIFO выбран вместо LRU, чтобы не платить лишним `Map.delete + Map.set`
// на каждом `get()` (read-tools mcp-kanban ходят по горячему набору и
// перестановки делали бы кеш бесполезным под нагрузкой). Для нашего профиля
// (TTL=10s, окно небольшое) FIFO даёт тот же эффект ограничения памяти
// без накладных расходов.

export interface CacheOptions {
  /** TTL ключа в миллисекундах. */
  ttlMs?: number;
  /** Источник «сейчас» — для детерминированных тестов. */
  now?: () => number;
  /**
   * Жёсткий потолок числа ключей. При превышении вытесняется самый старый
   * (FIFO). Защищает от безграничного роста, если ключи уникальны (например,
   * `get_issue` с разными `issueRef`'ами). По умолчанию — 2048.
   */
  maxEntries?: number;
  /**
   * Каждые N `set()` пробегаемся по карте и удаляем истёкшие записи. По
   * умолчанию — 256: лёгкий компромисс между лишней работой и накоплением
   * мусора по никогда-не-запрашиваемым ключам. 0 отключает sweep.
   */
  gcEvery?: number;
}

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_MAX_ENTRIES = 2048;
const DEFAULT_GC_EVERY = 256;

export type EvictionReason = 'ttl' | 'cap';

export interface EvictionStats {
  /** Удалено лениво по TTL (`get()` или периодический sweep). */
  ttl: number;
  /** Вытеснено по переполнению `maxEntries`. */
  cap: number;
}

export class TtlCache<T = unknown> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly map = new Map<string, { value: T; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly gcEvery: number;
  private setsSinceGc = 0;
  private readonly evictions: EvictionStats = { ttl: 0, cap: 0 };

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.gcEvery = Math.max(0, opts.gcEvery ?? DEFAULT_GC_EVERY);
  }

  /** Возвращает закешированное значение или undefined (включая истёкшие). */
  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      this.evictions.ttl += 1;
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Если ключ существует — обновляем без перестановки места в insertion-order.
    // (Map.set по существующему ключу сохраняет позицию; это поведение JS, мы
    // не пытаемся «освежить» порядок, потому что cap у нас FIFO, а не LRU.)
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });

    this.setsSinceGc += 1;
    if (this.gcEvery > 0 && this.setsSinceGc >= this.gcEvery) {
      this.setsSinceGc = 0;
      this.sweepExpired();
    }

    // FIFO cap: пока размер выше предела, выкидываем самый старый ключ.
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
      this.evictions.cap += 1;
    }
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

  /** Снимок счётчиков эвикции (для метрик/тестов). */
  evictionStats(): EvictionStats {
    return { ttl: this.evictions.ttl, cap: this.evictions.cap };
  }

  /** Текущий лимит — для прометей-гэйджа и интроспекции. */
  capacity(): number {
    return this.maxEntries;
  }

  /**
   * Принудительный sweep устаревших ключей. Вызывается автоматически из
   * `set()` каждые `gcEvery` раз; экспортирован для тестов и опционального
   * внешнего тика (например, перед /metrics scrape).
   */
  sweepExpired(): number {
    const cutoff = this.now();
    let removed = 0;
    for (const [k, entry] of this.map) {
      if (entry.expiresAt <= cutoff) {
        this.map.delete(k);
        removed += 1;
      }
    }
    this.evictions.ttl += removed;
    return removed;
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
