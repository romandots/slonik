import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

// SQLite-стор для bootstrap'а: маппинг agent identity → plane_user_id и
// активная стратегия (`per_user` / `single_bot`). Файл создаётся в
// `mcp_data/identity.sqlite` (внутри одноимённого docker volume) или в
// произвольном path для тестов (`:memory:` тоже допустим).
//
// SLONK-6: схема расширена полями `default_state` и `state_aliases`, чтобы
// перенести из захардкоженной таблицы в `claim_issue` маппинг
// «роль → колонка». Для старых баз делаем форвард-only миграцию через
// `ALTER TABLE … ADD COLUMN`; обе колонки nullable, чтобы не сломать
// инсталляции, которые ещё не перекатили bootstrap.

export interface IdentityMapping {
  role: string;
  email: string;
  plane_user_id: string | null;
  mode: 'per_user' | 'single_bot';
  /**
   * Имя колонки в Plane, в которую `claim_issue` переводит задачу по
   * умолчанию для этой роли. null означает «не задано» — в этом случае
   * `claim_issue` упадёт `INVALID_INPUT` с подсказкой пересоздать роль
   * через `make bootstrap` или передать `target_state` явно.
   */
  default_state: string | null;
  /**
   * Список синонимов имени `default_state` (case-insensitive), которые
   * `claim_issue` принимает при резолве `state_name → state_id`. Пустой
   * массив = «синонимов нет».
   */
  state_aliases: string[];
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
    this.migrateAddRoleStateColumns();
  }

  upsert(mapping: Omit<IdentityMapping, 'updated_at'>): void {
    this.db
      .prepare(
        `INSERT INTO identity_mapping (role, email, plane_user_id, mode, default_state, state_aliases, updated_at)
         VALUES (@role, @email, @plane_user_id, @mode, @default_state, @state_aliases, @updated_at)
         ON CONFLICT(role) DO UPDATE SET
           email = excluded.email,
           plane_user_id = excluded.plane_user_id,
           mode = excluded.mode,
           default_state = excluded.default_state,
           state_aliases = excluded.state_aliases,
           updated_at = excluded.updated_at`,
      )
      .run({
        role: mapping.role,
        email: mapping.email,
        plane_user_id: mapping.plane_user_id,
        mode: mapping.mode,
        default_state: mapping.default_state,
        // SQLite не хранит массивы — сериализуем в JSON. Пустой массив
        // намеренно сохраняется как `[]`, а не NULL, чтобы read-семантика
        // была однозначной.
        state_aliases: JSON.stringify(mapping.state_aliases),
        updated_at: new Date().toISOString(),
      });
  }

  get(role: string): IdentityMapping | undefined {
    const row = this.db
      .prepare(
        `SELECT role, email, plane_user_id, mode, default_state, state_aliases, updated_at
         FROM identity_mapping WHERE role = ?`,
      )
      .get(role) as RawIdentityRow | undefined;
    return row !== undefined ? rowToMapping(row) : undefined;
  }

  all(): IdentityMapping[] {
    const rows = this.db
      .prepare(
        `SELECT role, email, plane_user_id, mode, default_state, state_aliases, updated_at
         FROM identity_mapping ORDER BY role`,
      )
      .all() as RawIdentityRow[];
    return rows.map(rowToMapping);
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

  /**
   * Идемпотентная миграция: добавляет колонки `default_state` и
   * `state_aliases` если их нет. `ALTER TABLE … ADD COLUMN` в SQLite
   * атомарен и не блокирует чтения, поэтому безопасен на горячей базе.
   * Старым строкам колонки заполняются NULL и `'[]'` соответственно —
   * это значение «не задано» (см. рантайм-логику в `claim_issue`).
   */
  private migrateAddRoleStateColumns(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(identity_mapping)`)
      .all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('default_state')) {
      this.db.exec(`ALTER TABLE identity_mapping ADD COLUMN default_state TEXT`);
    }
    if (!have.has('state_aliases')) {
      // DEFAULT '[]' — чтобы read'ы по старым строкам не падали на
      // JSON.parse(null). Новые строки заполняются явно в `upsert()`.
      this.db.exec(`ALTER TABLE identity_mapping ADD COLUMN state_aliases TEXT NOT NULL DEFAULT '[]'`);
    }
  }
}

// Низкоуровневое представление строки таблицы. NOT NULL DEFAULT '[]' на
// `state_aliases` обеспечивает, что мы здесь не увидим null, но на
// миграции старая база может выдать пустую строку — обрабатываем
// в `rowToMapping`.
interface RawIdentityRow {
  role: string;
  email: string;
  plane_user_id: string | null;
  mode: 'per_user' | 'single_bot';
  default_state: string | null;
  state_aliases: string | null;
  updated_at: string;
}

function rowToMapping(row: RawIdentityRow): IdentityMapping {
  let aliases: string[] = [];
  if (row.state_aliases !== null && row.state_aliases !== '') {
    try {
      const parsed: unknown = JSON.parse(row.state_aliases);
      if (Array.isArray(parsed)) {
        aliases = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
      }
    } catch {
      // Битая запись (ручная правка БД, обрезка) — лечим до пустого
      // списка, чтобы не валить весь стартап MCP из-за одной строки.
      aliases = [];
    }
  }
  return {
    role: row.role,
    email: row.email,
    plane_user_id: row.plane_user_id,
    mode: row.mode,
    default_state: row.default_state,
    state_aliases: aliases,
    updated_at: row.updated_at,
  };
}
