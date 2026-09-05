import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { generateOpaqueToken } from './crypto.js';
import { CLIENT_EVICTION_GRACE_MS } from './defaults.js';

// SQLite-стор для встроенного OAuth 2.1 AS. Один файл хранит четыре коллекции:
//   - tenants:       тенанты (workspace → plane_api_key + auth credentials);
//   - oauth_clients: динамически зарегистрированные клиенты (DCR);
//   - oauth_codes:   authorization codes (single-use, короткий TTL);
//   - oauth_tokens:  access/refresh токены (refresh с ротацией и цепочкой).
// Плейнтекст токенов/кодов не храним — приходят уже хэшированными
// (см. `crypto.ts`). Security-критичные инварианты: code потребляется
// ровно один раз (атомарная транзакция), reuse refresh-токена «отравляет»
// всю цепочку (защита от кражи токена), revoke и expiry соблюдаются.
// Изоляция тенантов: каждый access-token привязан к workspace; PlaneClient
// выбирается per-workspace при обработке запроса.

export interface TenantRow {
  workspace: string;
  plane_api_key: string;
  /** SHA-256 hex-хэш статичного auth-токена для этого workspace (Bearer + X-Agent-Identity). */
  auth_token_hash: string;
  max_clients: number;
  created_at_ms: number;
}

export interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  created_at_ms: number;
}

export interface SaveCodeArgs {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  identity: string;
  scope: string;
  resource: string;
  workspace: string;
  expires_at_ms: number;
}

export interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  identity: string;
  scope: string;
  resource: string;
  workspace: string;
  expires_at_ms: number;
}

export interface SaveTokenArgs {
  token_hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  identity: string;
  scope: string;
  resource: string;
  workspace: string;
  expires_at_ms: number;
  refresh_chain_id: string;
}

export interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  identity: string;
  scope: string;
  resource: string;
  workspace: string;
  expires_at_ms: number;
  refresh_chain_id: string;
}

export class OAuthStore {
  private readonly db: Database.Database;
  private readonly maxClients: number;

  constructor(opts: { path: string; maxClients: number }) {
    if (opts.path !== ':memory:') {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    this.maxClients = opts.maxClients;
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        workspace        TEXT PRIMARY KEY,
        plane_api_key    TEXT NOT NULL,
        auth_token_hash  TEXT NOT NULL,
        max_clients      INTEGER NOT NULL DEFAULT 50,
        created_at_ms    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id                  TEXT PRIMARY KEY,
        client_name                TEXT NOT NULL,
        redirect_uris              TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
        created_at_ms              INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash      TEXT PRIMARY KEY,
        client_id      TEXT NOT NULL,
        redirect_uri   TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        identity       TEXT NOT NULL,
        scope          TEXT NOT NULL,
        resource       TEXT NOT NULL,
        workspace      TEXT NOT NULL DEFAULT '',
        expires_at_ms  INTEGER NOT NULL,
        used           INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash       TEXT PRIMARY KEY,
        kind             TEXT NOT NULL CHECK (kind IN ('access','refresh')),
        client_id        TEXT NOT NULL,
        identity         TEXT NOT NULL,
        scope            TEXT NOT NULL,
        resource         TEXT NOT NULL,
        workspace        TEXT NOT NULL DEFAULT '',
        expires_at_ms    INTEGER NOT NULL,
        refresh_chain_id TEXT NOT NULL,
        used             INTEGER NOT NULL DEFAULT 0,
        chain_poisoned   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_chain ON oauth_tokens (refresh_chain_id);
      CREATE INDEX IF NOT EXISTS idx_tenants_auth_hash ON tenants (auth_token_hash);
    `);
    this.migrateSchema();
  }

  /** Применяет миграции к существующим БД (добавляет колонки workspace). */
  private migrateSchema(): void {
    for (const table of ['oauth_codes', 'oauth_tokens'] as const) {
      const hasCol = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = 'workspace'`,
      ).get() as { n: number }).n > 0;
      if (!hasCol) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN workspace TEXT NOT NULL DEFAULT ''`);
      }
    }
  }

  // ---- Tenant management ----

  registerTenant(args: {
    workspace: string;
    plane_api_key: string;
    auth_token_hash: string;
    max_clients?: number;
    created_at_ms: number;
  }): TenantRow {
    const max_clients = args.max_clients ?? this.maxClients;
    this.db
      .prepare(
        `INSERT INTO tenants (workspace, plane_api_key, auth_token_hash, max_clients, created_at_ms)
         VALUES (@workspace, @plane_api_key, @auth_token_hash, @max_clients, @created_at_ms)
         ON CONFLICT(workspace) DO UPDATE SET
           plane_api_key   = excluded.plane_api_key,
           auth_token_hash = excluded.auth_token_hash,
           max_clients     = excluded.max_clients`,
      )
      .run({ workspace: args.workspace, plane_api_key: args.plane_api_key, auth_token_hash: args.auth_token_hash, max_clients, created_at_ms: args.created_at_ms });
    return { workspace: args.workspace, plane_api_key: args.plane_api_key, auth_token_hash: args.auth_token_hash, max_clients, created_at_ms: args.created_at_ms };
  }

  getTenantByWorkspace(workspace: string): TenantRow | undefined {
    return this.db
      .prepare('SELECT * FROM tenants WHERE workspace = @workspace')
      .get({ workspace }) as TenantRow | undefined;
  }

  /** Ищет тенанта по хэшу auth-токена (для static-token path). */
  getTenantByAuthTokenHash(auth_token_hash: string): TenantRow | undefined {
    return this.db
      .prepare('SELECT * FROM tenants WHERE auth_token_hash = @auth_token_hash')
      .get({ auth_token_hash }) as TenantRow | undefined;
  }

  listTenants(): TenantRow[] {
    return this.db.prepare('SELECT * FROM tenants ORDER BY created_at_ms').all() as TenantRow[];
  }

  // ---- OAuth clients ----

  /** Число зарегистрированных клиентов. */
  private countClients(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
  }

  /**
   * Удаляет протухшие коды и токены (без транзакции — вызывается изнутри).
   *
   * Поведение не меняется: истёкшую запись `consumeCode`,
   * `validateAccessToken` и `rotateRefreshToken` и так отвергают по
   * `expires_at_ms`. Не страдает и reuse-детекция refresh-цепочек — она
   * работает на живых токенах. Смысл только в том, чтобы база не росла
   * без границ: за время жизни стенда там накапливаются тысячи мёртвых
   * строк, а удаления не было вовсе.
   */
  private pruneExpiredRows(now_ms: number): { codes: number; tokens: number } {
    const codes = this.db
      .prepare('DELETE FROM oauth_codes WHERE expires_at_ms <= @now')
      .run({ now: now_ms }).changes;
    const tokens = this.db
      .prepare('DELETE FROM oauth_tokens WHERE expires_at_ms <= @now')
      .run({ now: now_ms }).changes;
    return { codes, tokens };
  }

  /** Удаляет протухшие коды и токены. Возвращает число удалённых строк. */
  pruneExpired(now_ms: number): { codes: number; tokens: number } {
    return this.db.transaction(() => this.pruneExpiredRows(now_ms))();
  }

  /**
   * Вытесняет клиентов, которыми никто не пользуется: ни одного живого
   * токена и возраст больше `CLIENT_EVICTION_GRACE_MS`. Удаляются от самых
   * старых; вместе с клиентом уходят его коды и токены, чтобы не оставлять
   * висячих строк.
   *
   * `limit` ограничивает число удалений (undefined — все подходящие).
   * Возвращает, сколько клиентов удалено.
   */
  private evictDeadClientRows(now_ms: number, limit?: number): number {
    const rows = this.db
      .prepare(
        `SELECT c.client_id FROM oauth_clients c
          WHERE c.created_at_ms <= @cutoff
            AND NOT EXISTS (
              SELECT 1 FROM oauth_tokens t
               WHERE t.client_id = c.client_id AND t.expires_at_ms > @now
            )
          ORDER BY c.created_at_ms ASC`,
      )
      .all({ now: now_ms, cutoff: now_ms - CLIENT_EVICTION_GRACE_MS }) as Array<{ client_id: string }>;

    const victims = limit === undefined ? rows : rows.slice(0, Math.max(limit, 0));
    for (const { client_id } of victims) {
      this.db.prepare('DELETE FROM oauth_tokens WHERE client_id = @client_id').run({ client_id });
      this.db.prepare('DELETE FROM oauth_codes WHERE client_id = @client_id').run({ client_id });
      this.db.prepare('DELETE FROM oauth_clients WHERE client_id = @client_id').run({ client_id });
    }
    return victims.length;
  }

  /** Публичная обёртка над вытеснением мёртвых клиентов (см. приватный метод). */
  evictDeadClients(now_ms: number, limit?: number): number {
    return this.db.transaction(() => this.evictDeadClientRows(now_ms, limit))();
  }

  registerClient(args: { client_name: string; redirect_uris: string[]; created_at_ms: number }): OAuthClientRow {
    const tx = this.db.transaction((): OAuthClientRow => {
      let count = this.countClients();
      if (count >= this.maxClients) {
        // Cap не должен быть тупиком. DCR создаёт нового клиента на каждое
        // переподключение (claude.ai — при каждой переавторизации), а
        // удаления не было вовсе: упёршись в потолок один раз, сервер
        // переставал принимать новых клиентов навсегда. Поэтому сначала
        // выбрасываем протухшее и тех, кем никто не пользуется, и только
        // если места всё равно нет — отказываем.
        this.pruneExpiredRows(args.created_at_ms);
        this.evictDeadClientRows(args.created_at_ms, count - this.maxClients + 1);
        count = this.countClients();
      }
      if (count >= this.maxClients) {
        throw new Error(
          `OAuth client cap reached (${this.maxClients}): every registered client still holds a live token. ` +
            'Raise MCP_OAUTH_MAX_CLIENTS or revoke tokens of clients that are no longer used.',
        );
      }
      const client_id = generateOpaqueToken();
      this.db
        .prepare(
          `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, created_at_ms)
           VALUES (@client_id, @client_name, @redirect_uris, 'none', @created_at_ms)`,
        )
        .run({
          client_id,
          client_name: args.client_name,
          redirect_uris: JSON.stringify(args.redirect_uris),
          created_at_ms: args.created_at_ms,
        });
      return {
        client_id,
        client_name: args.client_name,
        redirect_uris: args.redirect_uris,
        token_endpoint_auth_method: 'none',
        created_at_ms: args.created_at_ms,
      };
    });
    return tx();
  }

  getClient(client_id: string): OAuthClientRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM oauth_clients WHERE client_id = @client_id')
      .get({ client_id }) as (Omit<OAuthClientRow, 'redirect_uris'> & { redirect_uris: string }) | undefined;
    if (row === undefined) return undefined;
    return { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
  }

  saveCode(args: SaveCodeArgs): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, identity, scope, resource, workspace, expires_at_ms, used)
         VALUES (@code_hash, @client_id, @redirect_uri, @code_challenge, @identity, @scope, @resource, @workspace, @expires_at_ms, 0)`,
      )
      .run(args);
  }

  consumeCode(code_hash: string, now_ms: number): CodeRow | undefined {
    const tx = this.db.transaction((): CodeRow | undefined => {
      const row = this.db
        .prepare('SELECT * FROM oauth_codes WHERE code_hash = @code_hash AND used = 0')
        .get({ code_hash }) as CodeRow | undefined;
      if (row === undefined) return undefined;
      this.db.prepare('UPDATE oauth_codes SET used = 1 WHERE code_hash = @code_hash').run({ code_hash });
      if (row.expires_at_ms <= now_ms) return undefined;
      return row;
    });
    return tx();
  }

  saveToken(args: SaveTokenArgs): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (token_hash, kind, client_id, identity, scope, resource, workspace, expires_at_ms, refresh_chain_id, used, chain_poisoned)
         VALUES (@token_hash, @kind, @client_id, @identity, @scope, @resource, @workspace, @expires_at_ms, @refresh_chain_id, 0, 0)`,
      )
      .run(args);
  }

  validateAccessToken(token_hash: string, now_ms: number): TokenRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = @token_hash AND kind = 'access' AND used = 0 AND chain_poisoned = 0`)
      .get({ token_hash }) as TokenRow | undefined;
    if (row === undefined || row.expires_at_ms <= now_ms) return undefined;
    return row;
  }

  consumeRefreshToken(token_hash: string, now_ms: number): TokenRow | undefined {
    const tx = this.db.transaction((): TokenRow | undefined => {
      const row = this.db
        .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = @token_hash AND kind = 'refresh'`)
        .get({ token_hash }) as (TokenRow & { used: number; chain_poisoned: number }) | undefined;
      if (row === undefined) return undefined;
      if (row.chain_poisoned === 1 || row.expires_at_ms <= now_ms) return undefined;
      if (row.used === 1) {
        this.poisonChain(row.refresh_chain_id);
        return undefined;
      }
      this.db.prepare('UPDATE oauth_tokens SET used = 1 WHERE token_hash = @token_hash').run({ token_hash });
      return row;
    });
    return tx();
  }

  poisonChain(refresh_chain_id: string): void {
    this.db
      .prepare('UPDATE oauth_tokens SET chain_poisoned = 1 WHERE refresh_chain_id = @refresh_chain_id')
      .run({ refresh_chain_id });
  }

  revokeToken(token_hash: string): void {
    this.db.prepare('UPDATE oauth_tokens SET used = 1 WHERE token_hash = @token_hash').run({ token_hash });
  }

  /**
   * Отзыв по любому токену из цепочки: помечает сам токен used=1 И отравляет
   * весь refresh_chain_id (все access+refresh в цепочке становятся невалидны).
   * Используется endpoint'ом /oauth/revoke — отзыв должен завершать всю сессию
   * (RFC 7009 §2: отзыв refresh ДОЛЖЕН отзывать связанные access-токены).
   */
  revokeChainByToken(token_hash: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT refresh_chain_id FROM oauth_tokens WHERE token_hash = @token_hash')
        .get({ token_hash }) as { refresh_chain_id: string } | undefined;
      this.db.prepare('UPDATE oauth_tokens SET used = 1 WHERE token_hash = @token_hash').run({ token_hash });
      if (row !== undefined) {
        this.poisonChain(row.refresh_chain_id);
      }
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}
