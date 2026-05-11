import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

// SQLite-стор для bootstrap'а: маппинг agent identity → plane_user_id и
// активная стратегия (`per_user` / `single_bot`). Файл создаётся в
// `mcp_data/identity.sqlite` (внутри одноимённого docker volume) или в
// произвольном path для тестов (`:memory:` тоже допустим).

export interface IdentityMapping {
  role: string;
  email: string;
  plane_user_id: string | null;
  mode: 'per_user' | 'single_bot';
  /** ISO-8601 */
  updated_at: string;
}

export class IdentityStore {
  private readonly db: Database.Database;

  constructor(opts: { path: string }) {
    if (opts.path !== ':memory:') {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_mapping (
        role          TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        plane_user_id TEXT,
        mode          TEXT NOT NULL CHECK (mode IN ('per_user','single_bot')),
        updated_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bootstrap_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  upsert(mapping: Omit<IdentityMapping, 'updated_at'>): void {
    this.db
      .prepare(
        `INSERT INTO identity_mapping (role, email, plane_user_id, mode, updated_at)
         VALUES (@role, @email, @plane_user_id, @mode, @updated_at)
         ON CONFLICT(role) DO UPDATE SET
           email = excluded.email,
           plane_user_id = excluded.plane_user_id,
           mode = excluded.mode,
           updated_at = excluded.updated_at`,
      )
      .run({ ...mapping, updated_at: new Date().toISOString() });
  }

  get(role: string): IdentityMapping | undefined {
    const row = this.db
      .prepare(
        `SELECT role, email, plane_user_id, mode, updated_at
         FROM identity_mapping WHERE role = ?`,
      )
      .get(role) as IdentityMapping | undefined;
    return row;
  }

  all(): IdentityMapping[] {
    return this.db
      .prepare(
        `SELECT role, email, plane_user_id, mode, updated_at
         FROM identity_mapping ORDER BY role`,
      )
      .all() as IdentityMapping[];
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO bootstrap_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM bootstrap_meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  close(): void {
    this.db.close();
  }
}
