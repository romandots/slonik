import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { generateOpaqueToken } from './crypto.js';

// SQLite-стор для встроенного OAuth 2.1 AS. Один файл хранит три коллекции:
//   - oauth_clients: динамически зарегистрированные клиенты (DCR);
//   - oauth_codes:   authorization codes (single-use, короткий TTL);
//   - oauth_tokens:  access/refresh токены (refresh с ротацией и цепочкой).
// Плейнтекст токенов/кодов не храним — приходят уже хэшированными
// (см. `crypto.ts`). Security-критичные инварианты: code потребляется
// ровно один раз (атомарная транзакция), reuse refresh-токена «отравляет»
// всю цепочку (защита от кражи токена), revoke и expiry соблюдаются.

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
  expires_at_ms: number;
}

export interface SaveTokenArgs {
  token_hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  identity: string;
  scope: string;
  resource: string;
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
        expires_at_ms    INTEGER NOT NULL,
        refresh_chain_id TEXT NOT NULL,
        used             INTEGER NOT NULL DEFAULT 0,
        chain_poisoned   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_chain ON oauth_tokens (refresh_chain_id);
    `);
  }

  registerClient(args: { client_name: string; redirect_uris: string[]; created_at_ms: number }): OAuthClientRow {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
    if (count >= this.maxClients) {
      throw new Error(`OAuth client cap reached (${this.maxClients})`);
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
        `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, identity, scope, resource, expires_at_ms, used)
         VALUES (@code_hash, @client_id, @redirect_uri, @code_challenge, @identity, @scope, @resource, @expires_at_ms, 0)`,
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
        `INSERT INTO oauth_tokens (token_hash, kind, client_id, identity, scope, resource, expires_at_ms, refresh_chain_id, used, chain_poisoned)
         VALUES (@token_hash, @kind, @client_id, @identity, @scope, @resource, @expires_at_ms, @refresh_chain_id, 0, 0)`,
      )
      .run(args);
  }

  validateAccessToken(token_hash: string, now_ms: number): TokenRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = @token_hash AND kind = 'access' AND used = 0`)
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

  close(): void {
    this.db.close();
  }
}
