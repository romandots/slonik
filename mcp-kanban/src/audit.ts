import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

// Audit log для write-операций. Один файл — `mcp_data/audit.sqlite`.
// Схема — SPEC.md §6.7.

export interface AuditEntry {
  trace_id: string;
  ts: string;
  identity: string;
  tool: string;
  /** SHA-256 prefix от stable-JSON входа; не содержит сырого payload. */
  input_hash: string;
  /** Plane request-id, если получили; null если ответа не было. */
  plane_request_id: string | null;
  outcome: 'success' | 'error';
  error_code: string | null;
  /** Опциональное событие. Для claim-race: 'claim'. */
  event: string | null;
  /** issue_id, если применимо (для дедупликации claim-race и поиска). */
  issue_id: string | null;
}

export class AuditLog {
  private readonly db: Database.Database;

  constructor(opts: { path: string }) {
    if (opts.path !== ':memory:') {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        trace_id          TEXT PRIMARY KEY,
        ts                TEXT NOT NULL,
        identity          TEXT NOT NULL,
        tool              TEXT NOT NULL,
        input_hash        TEXT NOT NULL,
        plane_request_id  TEXT,
        outcome           TEXT NOT NULL CHECK (outcome IN ('success','error')),
        error_code        TEXT,
        event             TEXT,
        issue_id          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_issue_event_ts
        ON audit_log (issue_id, event, ts);

      -- Уникальный замок claim: гарантирует, что только один claim успешно
      -- запишется. Атомарный insert является нашей seriliazation-точкой
      -- (см. claim_issue handler).
      CREATE TABLE IF NOT EXISTS claim_lock (
        issue_id    TEXT PRIMARY KEY,
        identity    TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        trace_id    TEXT NOT NULL
      );
    `);
  }

  record(entry: Omit<AuditEntry, 'ts'>): void {
    this.db
      .prepare(
        `INSERT INTO audit_log
           (trace_id, ts, identity, tool, input_hash, plane_request_id, outcome, error_code, event, issue_id)
         VALUES
           (@trace_id, @ts, @identity, @tool, @input_hash, @plane_request_id, @outcome, @error_code, @event, @issue_id)`,
      )
      .run({ ...entry, ts: new Date().toISOString() });
  }

  list(filter: { issue_id?: string; identity?: string; limit?: number } = {}): AuditEntry[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.issue_id !== undefined) {
      where.push('issue_id = @issue_id');
      params['issue_id'] = filter.issue_id;
    }
    if (filter.identity !== undefined) {
      where.push('identity = @identity');
      params['identity'] = filter.identity;
    }
    const sql = `SELECT * FROM audit_log
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ts DESC
      LIMIT @limit`;
    params['limit'] = filter.limit ?? 100;
    return this.db.prepare(sql).all(params) as AuditEntry[];
  }

  /**
   * Атомарный «забор» issue-claim. Возвращает true только если запись
   * вставлена нашим вызовом (никто другой её ещё не держал).
   */
  tryAcquireClaim(args: { issue_id: string; identity: string; trace_id: string }): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO claim_lock (issue_id, identity, acquired_at, trace_id)
           VALUES (@issue_id, @identity, @acquired_at, @trace_id)`,
        )
        .run({ ...args, acquired_at: new Date().toISOString() });
      return true;
    } catch (err) {
      // UNIQUE constraint violation → claim уже взят.
      if (err instanceof Error && /UNIQUE/i.test(err.message)) return false;
      throw err;
    }
  }

  /**
   * Снимает claim. Если claim не наш — return false (release_issue должен
   * вернуть ошибку).
   */
  releaseClaim(args: { issue_id: string; identity: string }): boolean {
    const info = this.db
      .prepare(`DELETE FROM claim_lock WHERE issue_id = @issue_id AND identity = @identity`)
      .run(args);
    return info.changes > 0;
  }

  currentClaim(
    issue_id: string,
  ): { identity: string; acquired_at: string; trace_id: string } | undefined {
    return this.db
      .prepare(
        `SELECT identity, acquired_at, trace_id FROM claim_lock WHERE issue_id = @issue_id`,
      )
      .get({ issue_id }) as
      | { identity: string; acquired_at: string; trace_id: string }
      | undefined;
  }

  close(): void {
    this.db.close();
  }
}

export function newTraceId(): string {
  return randomUUID();
}

export function hashInput(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value))
    .digest('hex')
    .slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
      )
      .join(',') +
    '}'
  );
}
