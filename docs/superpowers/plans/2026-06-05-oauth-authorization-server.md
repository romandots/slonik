# Embedded OAuth 2.1 Authorization Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an embedded OAuth 2.1 Authorization Server to `mcp-kanban` so a self-hosted slonk can be added as a remote connector on claude.ai (OAuth discovery + Authorization Code + PKCE + Dynamic Client Registration), gated behind a default-off feature flag.

**Architecture:** `mcp-kanban` plays both Resource Server (the existing `/mcp`) and Authorization Server (new `/oauth/*` + `/.well-known/*`) in one Fastify process. A new `src/oauth/` module holds a pure crypto core, a `better-sqlite3` store (`oauth.sqlite`), pure metadata builders, and Fastify route registration. When `MCP_OAUTH_ENABLED=false` (default) nothing changes: OAuth routes are not registered and `/mcp` keeps accepting only the static `MCP_AUTH_TOKEN`. When enabled, `/mcp` additionally accepts opaque OAuth access tokens that resolve to the `operator` identity.

**Tech Stack:** TypeScript (strict), Fastify, `@fastify/formbody` (new dep — urlencoded bodies on token/authorize), `better-sqlite3`, `zod`, Node `crypto`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-06-05-oauth-authorization-server-design.md`

**Conventions reminder:** functional core / side-effects on edges; no `any` without justified `eslint-disable`; tool/handler contract returns structured objects; never log tokens/secrets; `pnpm test`, `pnpm typecheck`, `pnpm lint` must stay green. Commit messages: Conventional Commits, no LLM/agent mentions.

---

## File Structure

**Create:**
- `mcp-kanban/src/oauth/crypto.ts` — pure: opaque token generation, SHA-256 hashing, PKCE `S256` verification, constant-time compare re-export.
- `mcp-kanban/src/oauth/crypto.test.ts`
- `mcp-kanban/src/oauth/store.ts` — `OAuthStore` (better-sqlite3): `oauth_clients`, `oauth_codes`, `oauth_tokens`; client registration with cap, single-use code consumption, token issue/lookup/revoke, refresh rotation with chain invalidation.
- `mcp-kanban/src/oauth/store.test.ts`
- `mcp-kanban/src/oauth/metadata.ts` — pure: `buildProtectedResourceMetadata()` (RFC 9728), `buildAuthorizationServerMetadata()` (RFC 8414).
- `mcp-kanban/src/oauth/metadata.test.ts`
- `mcp-kanban/src/oauth/routes.ts` — `registerOAuthRoutes(app, deps)`: `/.well-known/*`, `/oauth/register`, `/oauth/authorize` (GET form + POST), `/oauth/token`, `/oauth/revoke`, plus the login HTML renderer.
- `mcp-kanban/src/oauth/routes.test.ts` — full flow + negative cases via `fastify.inject`.

**Modify:**
- `mcp-kanban/src/config.ts` — add `MCP_OAUTH_*` env vars + refine (`MCP_OAUTH_ISSUER` required when enabled).
- `mcp-kanban/src/auth.ts` — extend `authenticate()` to accept an optional OAuth token validator; static token path unchanged.
- `mcp-kanban/src/server.ts` — instantiate `OAuthStore`, register OAuth routes + formbody when enabled, inject operator identity into the registry, wire OAuth validator into `/mcp` auth, expose store on `BuiltServer`, close store on shutdown.
- `mcp-kanban/src/logger.ts` — redact OAuth token/secret fields.
- `mcp-kanban/package.json` — add `@fastify/formbody`.
- `.env.example`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/ROADMAP.md`, `docs/CHANGELOG.md` — documentation (final task).

---

## Task 1: Config — OAuth env vars

**Files:**
- Modify: `mcp-kanban/src/config.ts`
- Test: `mcp-kanban/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `mcp-kanban/src/config.test.ts`:

```typescript
describe('OAuth config', () => {
  const base = {
    MCP_AUTH_TOKEN: 'a'.repeat(64),
    PLANE_API_BASE_URL: 'http://plane.invalid/api/v1',
    NODE_ENV: 'test' as const,
  };

  it('defaults MCP_OAUTH_ENABLED to false and skips issuer requirement', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.MCP_OAUTH_ENABLED).toBe(false);
    expect(cfg.MCP_OAUTH_OPERATOR_IDENTITY).toBe('operator');
    expect(cfg.MCP_OAUTH_ACCESS_TTL_SEC).toBe(3600);
  });

  it('requires MCP_OAUTH_ISSUER when OAuth enabled', () => {
    expect(() => loadConfig({ ...base, MCP_OAUTH_ENABLED: '1' })).toThrow(/MCP_OAUTH_ISSUER/);
  });

  it('accepts a valid issuer URL when enabled', () => {
    const cfg = loadConfig({ ...base, MCP_OAUTH_ENABLED: '1', MCP_OAUTH_ISSUER: 'https://slonk.example.com' });
    expect(cfg.MCP_OAUTH_ENABLED).toBe(true);
    expect(cfg.MCP_OAUTH_ISSUER).toBe('https://slonk.example.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-kanban && pnpm vitest run src/config.test.ts -t "OAuth config"`
Expected: FAIL (`MCP_OAUTH_ENABLED` undefined / no refine).

- [ ] **Step 3: Implement the config fields**

In `mcp-kanban/src/config.ts`, add these fields to the `ConfigSchema` object (after `MCP_METRICS_ENABLED`):

```typescript
  // OAuth 2.1 Authorization Server (claude.ai remote connector). Off by default.
  MCP_OAUTH_ENABLED: Bool01.default(false),
  // Публичный base URL сервера; нужен для metadata и redirect. Обязателен
  // при MCP_OAUTH_ENABLED=1 (см. superRefine ниже). Без trailing slash.
  MCP_OAUTH_ISSUER: optionalNonEmpty.pipe(z.string().url().optional()),
  MCP_OAUTH_OPERATOR_IDENTITY: z.string().min(1).default('operator'),
  MCP_OAUTH_ACCESS_TTL_SEC: PositiveInt.default(3600),
  MCP_OAUTH_REFRESH_TTL_SEC: PositiveInt.default(2_592_000),
  MCP_OAUTH_CODE_TTL_SEC: PositiveInt.default(60),
  MCP_OAUTH_MAX_CLIENTS: PositiveInt.default(50),
  MCP_OAUTH_STORE_PATH: optionalNonEmpty,
```

Then add a cross-field refine. Change `const ConfigSchema = z.object({ ... });` so it ends with `.superRefine(...)`:

```typescript
}).superRefine((cfg, ctx) => {
  if (cfg.MCP_OAUTH_ENABLED && cfg.MCP_OAUTH_ISSUER === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MCP_OAUTH_ISSUER'],
      message: 'MCP_OAUTH_ISSUER is required when MCP_OAUTH_ENABLED=1',
    });
  }
});
```

Note: `z.infer<typeof ConfigSchema>` still works through `.superRefine`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-kanban && pnpm vitest run src/config.test.ts`
Expected: PASS (all config tests).

- [ ] **Step 5: Typecheck**

Run: `cd mcp-kanban && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add mcp-kanban/src/config.ts mcp-kanban/src/config.test.ts
git commit -m "feat(oauth): add OAuth AS config flags (SLONK-oauth)"
```

---

## Task 2: OAuth crypto core (pure)

**Files:**
- Create: `mcp-kanban/src/oauth/crypto.ts`
- Test: `mcp-kanban/src/oauth/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mcp-kanban/src/oauth/crypto.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  generateOpaqueToken,
  hashToken,
  verifyPkceS256,
  base64UrlSha256,
} from './crypto.js';

describe('oauth crypto', () => {
  it('generateOpaqueToken returns a 43-char base64url string, unique each call', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashToken is deterministic sha256 hex', () => {
    expect(hashToken('hello')).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  it('base64UrlSha256 matches the PKCE reference encoding', () => {
    const verifier = randomBytes(32).toString('base64url');
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(base64UrlSha256(verifier)).toBe(expected);
  });

  it('verifyPkceS256 accepts a matching verifier and rejects a wrong one', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256('wrong-verifier', challenge)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-kanban && pnpm vitest run src/oauth/crypto.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement crypto core**

Create `mcp-kanban/src/oauth/crypto.ts`:

```typescript
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Случайный opaque-токен/код: 32 байта → 43 символа base64url. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex — для хранения токенов/кодов в покое (плейнтекст не храним). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** base64url(sha256(input)) — PKCE S256 transform (RFC 7636 §4.2). */
export function base64UrlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

/**
 * Проверяет PKCE code_verifier против сохранённого code_challenge (S256).
 * Сравнение константного времени. Возвращает false при любом несовпадении
 * длины/содержимого.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = base64UrlSha256(codeVerifier);
  return constantTimeEqual(computed, codeChallenge);
}

/** Сравнение строк за константное время. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-kanban && pnpm vitest run src/oauth/crypto.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-kanban/src/oauth/crypto.ts mcp-kanban/src/oauth/crypto.test.ts
git commit -m "feat(oauth): add pure crypto core (token gen, hashing, PKCE S256)"
```

---

## Task 3: OAuthStore (SQLite)

**Files:**
- Create: `mcp-kanban/src/oauth/store.ts`
- Test: `mcp-kanban/src/oauth/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mcp-kanban/src/oauth/store.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OAuthStore } from './store.js';

describe('OAuthStore', () => {
  let store: OAuthStore;
  beforeEach(() => {
    store = new OAuthStore({ path: ':memory:', maxClients: 3 });
  });
  afterEach(() => store.close());

  const now = 1_000_000; // фиксированное «сейчас» в ms

  it('registers a client and reads it back', () => {
    const c = store.registerClient({
      client_name: 'claude.ai',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      created_at_ms: now,
    });
    expect(c.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const got = store.getClient(c.client_id);
    expect(got?.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('enforces the client cap', () => {
    for (let i = 0; i < 3; i += 1) {
      store.registerClient({ client_name: `c${i}`, redirect_uris: ['https://x/cb'], created_at_ms: now });
    }
    expect(() =>
      store.registerClient({ client_name: 'overflow', redirect_uris: ['https://x/cb'], created_at_ms: now }),
    ).toThrow(/cap/i);
  });

  it('consumes an authorization code exactly once', () => {
    store.saveCode({
      code_hash: 'h1', client_id: 'c1', redirect_uri: 'https://x/cb',
      code_challenge: 'chal', identity: 'operator', scope: 'mcp',
      resource: 'https://slonk/mcp', expires_at_ms: now + 60_000,
    });
    const first = store.consumeCode('h1', now);
    expect(first?.client_id).toBe('c1');
    const second = store.consumeCode('h1', now);
    expect(second).toBeUndefined(); // already used
  });

  it('rejects an expired authorization code', () => {
    store.saveCode({
      code_hash: 'h2', client_id: 'c1', redirect_uri: 'https://x/cb',
      code_challenge: 'chal', identity: 'operator', scope: 'mcp',
      resource: 'https://slonk/mcp', expires_at_ms: now - 1,
    });
    expect(store.consumeCode('h2', now)).toBeUndefined();
  });

  it('issues an access token and validates it before expiry', () => {
    store.saveToken({
      token_hash: 't1', kind: 'access', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 3600_000, refresh_chain_id: 'chain1',
    });
    expect(store.validateAccessToken('t1', now)?.identity).toBe('operator');
    expect(store.validateAccessToken('t1', now + 3_600_001)).toBeUndefined();
    expect(store.validateAccessToken('nope', now)).toBeUndefined();
  });

  it('rotates a refresh token and invalidates the whole chain on reuse', () => {
    store.saveToken({
      token_hash: 'r1', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 9_000_000, refresh_chain_id: 'chainA',
    });
    const used = store.consumeRefreshToken('r1', now);
    expect(used?.refresh_chain_id).toBe('chainA');
    // Re-using r1 must fail AND poison the chain.
    expect(store.consumeRefreshToken('r1', now)).toBeUndefined();
    // A second refresh r2 in the same chain is now invalid (chain poisoned).
    store.saveToken({
      token_hash: 'r2', kind: 'refresh', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 9_000_000, refresh_chain_id: 'chainA',
    });
    store.poisonChain('chainA');
    expect(store.consumeRefreshToken('r2', now)).toBeUndefined();
  });

  it('revokes an access token', () => {
    store.saveToken({
      token_hash: 't9', kind: 'access', client_id: 'c1', identity: 'operator',
      scope: 'mcp', resource: 'https://slonk/mcp',
      expires_at_ms: now + 3600_000, refresh_chain_id: 'c9',
    });
    store.revokeToken('t9');
    expect(store.validateAccessToken('t9', now)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-kanban && pnpm vitest run src/oauth/store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the store**

Create `mcp-kanban/src/oauth/store.ts` (mirrors the `better-sqlite3` pattern in `src/git-refs.ts` / `src/audit.ts`):

```typescript
import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { generateOpaqueToken } from './crypto.js';

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

  /** Atomic single-use: помечает used=1 только если код был свеж и не истёк. */
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

  /** Atomic single-use refresh consume; на повторном использовании — отравляет цепочку. */
  consumeRefreshToken(token_hash: string, now_ms: number): TokenRow | undefined {
    const tx = this.db.transaction((): TokenRow | undefined => {
      const row = this.db
        .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = @token_hash AND kind = 'refresh'`)
        .get({ token_hash }) as (TokenRow & { used: number; chain_poisoned: number }) | undefined;
      if (row === undefined) return undefined;
      if (row.chain_poisoned === 1 || row.expires_at_ms <= now_ms) return undefined;
      if (row.used === 1) {
        // Re-use of a rotated refresh token → token theft signal: poison chain.
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
```

Note: `validateAccessToken` also returns `undefined` for poisoned/revoked access tokens because `used=1` excludes them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-kanban && pnpm vitest run src/oauth/store.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `cd mcp-kanban && pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add mcp-kanban/src/oauth/store.ts mcp-kanban/src/oauth/store.test.ts
git commit -m "feat(oauth): add SQLite store for clients, codes, tokens with refresh rotation"
```

---

## Task 4: Metadata builders (pure)

**Files:**
- Create: `mcp-kanban/src/oauth/metadata.ts`
- Test: `mcp-kanban/src/oauth/metadata.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mcp-kanban/src/oauth/metadata.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildProtectedResourceMetadata,
  buildAuthorizationServerMetadata,
} from './metadata.js';

const ISSUER = 'https://slonk.example.com';

describe('oauth metadata', () => {
  it('protected resource metadata points at the AS and the /mcp resource', () => {
    const m = buildProtectedResourceMetadata(ISSUER);
    expect(m.resource).toBe('https://slonk.example.com/mcp');
    expect(m.authorization_servers).toEqual([ISSUER]);
    expect(m.bearer_methods_supported).toContain('header');
  });

  it('authorization server metadata advertises PKCE S256 and the right endpoints', () => {
    const m = buildAuthorizationServerMetadata(ISSUER);
    expect(m.issuer).toBe(ISSUER);
    expect(m.authorization_endpoint).toBe('https://slonk.example.com/oauth/authorize');
    expect(m.token_endpoint).toBe('https://slonk.example.com/oauth/token');
    expect(m.registration_endpoint).toBe('https://slonk.example.com/oauth/register');
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.response_types_supported).toEqual(['code']);
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('trims a trailing slash on the issuer', () => {
    const m = buildAuthorizationServerMetadata('https://slonk.example.com/');
    expect(m.issuer).toBe('https://slonk.example.com');
    expect(m.token_endpoint).toBe('https://slonk.example.com/oauth/token');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-kanban && pnpm vitest run src/oauth/metadata.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement metadata builders**

Create `mcp-kanban/src/oauth/metadata.ts`:

```typescript
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

export const OAUTH_SCOPE = 'mcp';

function trimSlash(issuer: string): string {
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
}

/** RFC 9728 — Protected Resource Metadata. */
export function buildProtectedResourceMetadata(issuer: string): ProtectedResourceMetadata {
  const base = trimSlash(issuer);
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/** RFC 8414 — Authorization Server Metadata. */
export function buildAuthorizationServerMetadata(issuer: string): AuthorizationServerMetadata {
  const base = trimSlash(issuer);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/** Canonical resource URI for audience binding (RFC 8707). */
export function resourceUri(issuer: string): string {
  return `${trimSlash(issuer)}/mcp`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-kanban && pnpm vitest run src/oauth/metadata.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-kanban/src/oauth/metadata.ts mcp-kanban/src/oauth/metadata.test.ts
git commit -m "feat(oauth): add RFC 9728/8414 metadata builders"
```

---

## Task 5: Auth integration — accept OAuth tokens on /mcp

**Files:**
- Modify: `mcp-kanban/src/auth.ts`
- Test: `mcp-kanban/src/auth.test.ts`

The OAuth validator is a synchronous callback (better-sqlite3 reads are sync). When the presented Bearer is NOT the static token, `authenticate` tries the validator; on success it sets `request.identity` from the token and skips the `X-Agent-Identity` requirement.

- [ ] **Step 1: Write the failing test**

Add to `mcp-kanban/src/auth.test.ts` (reuse existing imports for `authenticate`, `McpError`, a fake registry):

```typescript
describe('authenticate with OAuth validator', () => {
  const registry = { has: (id: string) => id === 'operator', list: () => ['operator'], size: 1 };
  const STATIC = 's'.repeat(40);

  function req(headers: Record<string, string>) {
    return { headers } as unknown as Parameters<typeof authenticate>[0];
  }
  const reply = {} as Parameters<typeof authenticate>[1];

  it('accepts a valid OAuth access token and resolves identity from it', () => {
    const r = req({ authorization: 'Bearer oauth-abc' });
    authenticate(r, reply, {
      expectedToken: STATIC,
      identityRegistry: registry,
      oauthValidator: (tok) => (tok === 'oauth-abc' ? { identity: 'operator', scope: 'mcp' } : undefined),
    });
    expect((r as unknown as { identity: string }).identity).toBe('operator');
  });

  it('still accepts the static token with X-Agent-Identity', () => {
    const r = req({ authorization: `Bearer ${STATIC}`, 'x-agent-identity': 'operator' });
    authenticate(r, reply, { expectedToken: STATIC, identityRegistry: registry, oauthValidator: () => undefined });
    expect((r as unknown as { identity: string }).identity).toBe('operator');
  });

  it('rejects an unknown Bearer when the validator returns undefined', () => {
    const r = req({ authorization: 'Bearer nope' });
    expect(() =>
      authenticate(r, reply, { expectedToken: STATIC, identityRegistry: registry, oauthValidator: () => undefined }),
    ).toThrow(McpError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-kanban && pnpm vitest run src/auth.test.ts -t "OAuth validator"`
Expected: FAIL (`oauthValidator` not in `AuthOptions`).

- [ ] **Step 3: Extend `authenticate`**

In `mcp-kanban/src/auth.ts`:

Add to `AuthOptions`:

```typescript
  /**
   * Опциональный валидатор OAuth access-токена. Если presented Bearer не
   * равен статичному expectedToken — пробуем его как OAuth-токен. Успех →
   * identity берётся из токена, X-Agent-Identity не требуется. Sync, потому
   * что lookup идёт в better-sqlite3 (синхронный).
   */
  oauthValidator?: (token: string) => { identity: AgentIdentity; scope: string } | undefined;
```

Replace the body from the `presented` check onward:

```typescript
  const presented = match[1];
  if (presented === undefined) {
    throw new McpError({ code: 'UNAUTHORIZED', message: 'Invalid bearer token' });
  }

  // Path A — статичный shared-token: identity из X-Agent-Identity (как было).
  if (constantTimeEqual(presented, options.expectedToken)) {
    applyStaticIdentity(request, options);
    return;
  }

  // Path B — OAuth access-токен (если включён валидатор).
  if (options.oauthValidator !== undefined) {
    const resolved = options.oauthValidator(presented);
    if (resolved !== undefined) {
      (request as AuthedRequest).identity = resolved.identity;
      return;
    }
  }

  throw new McpError({ code: 'UNAUTHORIZED', message: 'Invalid bearer token' });
}

function applyStaticIdentity(request: FastifyRequest, options: AuthOptions): void {
  if (options.requireIdentity === false) return;
  if (options.identityRegistry === undefined) {
    throw new McpError({ code: 'INTERNAL', message: 'identity registry not configured' });
  }
  const idHeader = request.headers['x-agent-identity'];
  const id = Array.isArray(idHeader) ? idHeader[0] : idHeader;
  if (typeof id !== 'string' || id.length === 0) {
    throw new McpError({ code: 'IDENTITY_REQUIRED', message: 'X-Agent-Identity header required' });
  }
  if (!options.identityRegistry.has(id)) {
    throw new McpError({ code: 'IDENTITY_REQUIRED', message: `Unknown agent identity: ${id}` });
  }
  (request as AuthedRequest).identity = id;
}
```

Keep the existing `constantTimeEqual` helper at the bottom of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp-kanban && pnpm vitest run src/auth.test.ts`
Expected: PASS (existing + new OAuth tests).

- [ ] **Step 5: Typecheck**

Run: `cd mcp-kanban && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add mcp-kanban/src/auth.ts mcp-kanban/src/auth.test.ts
git commit -m "feat(oauth): accept OAuth access tokens in authenticate()"
```

---

## Task 6: OAuth routes

**Files:**
- Modify: `mcp-kanban/package.json` (add `@fastify/formbody`)
- Create: `mcp-kanban/src/oauth/routes.ts`
- Test: `mcp-kanban/src/oauth/routes.test.ts`

- [ ] **Step 1: Add the formbody dependency**

Run: `cd mcp-kanban && pnpm add @fastify/formbody`
Expected: `package.json` + lockfile updated. This plugin parses `application/x-www-form-urlencoded` bodies (required by the OAuth token + authorize-POST endpoints).

- [ ] **Step 2: Write the failing test**

Create `mcp-kanban/src/oauth/routes.test.ts`. This is the full-flow integration test driven through Fastify `inject`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { randomBytes, createHash } from 'node:crypto';
import { OAuthStore } from './store.js';
import { registerOAuthRoutes } from './routes.js';
import { createLogger } from '../logger.js';
import { RateLimiter } from '../rate-limit.js';

const ISSUER = 'https://slonk.example.com';
const STATIC_TOKEN = 'p'.repeat(40); // operator password == MCP_AUTH_TOKEN
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('oauth routes (full flow)', () => {
  let app: FastifyInstance;
  let store: OAuthStore;

  beforeEach(async () => {
    store = new OAuthStore({ path: ':memory:', maxClients: 10 });
    app = Fastify();
    await app.register(formbody);
    registerOAuthRoutes(app, {
      store,
      issuer: ISSUER,
      authToken: STATIC_TOKEN,
      operatorIdentity: 'operator',
      accessTtlSec: 3600,
      refreshTtlSec: 2_592_000,
      codeTtlSec: 60,
      rateLimiter: new RateLimiter({ globalRps: 1000, identityRps: 1000 }),
      logger: createLogger({ MCP_LOG_LEVEL: 'fatal', NODE_ENV: 'test' }),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    store.close();
  });

  it('serves protected-resource metadata', async () => {
    const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).resource).toBe('https://slonk.example.com/mcp');
  });

  it('serves authorization-server metadata', async () => {
    const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).code_challenge_methods_supported).toEqual(['S256']);
  });

  it('runs register → authorize → token → refresh', async () => {
    // 1. DCR
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'claude.ai', redirect_uris: [REDIRECT] },
    });
    expect(reg.statusCode).toBe(201);
    const clientId = JSON.parse(reg.body).client_id as string;
    expect(clientId).toBeTruthy();

    // 2. authorize GET renders the login form
    const { verifier, challenge } = pkce();
    const authQuery =
      `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(ISSUER + '/mcp')}`;
    const form = await app.inject({ method: 'GET', url: `/oauth/authorize${authQuery}` });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('<form');

    // 3. authorize POST with the operator password → 302 to redirect with code
    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: {
        password: STATIC_TOKEN, client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz',
        resource: `${ISSUER}/mcp`,
      },
    });
    expect(post.statusCode).toBe(302);
    const location = new URL(post.headers.location as string);
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code') as string;
    expect(code).toBeTruthy();

    // 4. token exchange with the PKCE verifier
    const tok = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: {
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        client_id: clientId, code_verifier: verifier,
      },
    });
    expect(tok.statusCode).toBe(200);
    const body = JSON.parse(tok.body);
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.expires_in).toBe(3600);

    // 5. refresh rotation
    const refreshed = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: clientId },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(JSON.parse(refreshed.body).access_token).not.toBe(body.access_token);
  });

  it('rejects a wrong operator password', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'c', redirect_uris: [REDIRECT] },
    });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { challenge } = pkce();
    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: {
        password: 'wrong', client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ISSUER}/mcp`,
      },
    });
    expect(post.statusCode).toBe(401);
  });

  it('rejects an unregistered redirect_uri at authorize', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'c', redirect_uris: [REDIRECT] },
    });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { challenge } = pkce();
    const r = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=s&resource=${encodeURIComponent(ISSUER + '/mcp')}`,
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects a token exchange with a wrong PKCE verifier', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'c', redirect_uris: [REDIRECT] },
    });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { challenge } = pkce();
    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: {
        password: STATIC_TOKEN, client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ISSUER}/mcp`,
      },
    });
    const code = new URL(post.headers.location as string).searchParams.get('code') as string;
    const tok = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'wrong' },
    });
    expect(tok.statusCode).toBe(400);
  });

  it('rejects reusing an authorization code', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'c', redirect_uris: [REDIRECT] },
    });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { verifier, challenge } = pkce();
    const post = await app.inject({
      method: 'POST', url: '/oauth/authorize',
      payload: {
        password: STATIC_TOKEN, client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ISSUER}/mcp`,
      },
    });
    const code = new URL(post.headers.location as string).searchParams.get('code') as string;
    const first = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST', url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier },
    });
    expect(second.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd mcp-kanban && pnpm vitest run src/oauth/routes.test.ts`
Expected: FAIL (module `./routes.js` not found).

- [ ] **Step 4: Implement the routes**

Create `mcp-kanban/src/oauth/routes.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { RateLimiter } from '../rate-limit.js';
import { OAuthStore } from './store.js';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  resourceUri,
  OAUTH_SCOPE,
} from './metadata.js';
import { generateOpaqueToken, hashToken, verifyPkceS256, constantTimeEqual } from './crypto.js';

export interface OAuthRouteDeps {
  store: OAuthStore;
  issuer: string;
  authToken: string;       // operator password == MCP_AUTH_TOKEN
  operatorIdentity: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  codeTtlSec: number;
  rateLimiter: RateLimiter;
  logger: Logger;
  /** Override of "now" in ms for tests. */
  now?: () => number;
}

const RegisterBody = z.object({
  client_name: z.string().min(1).max(256).optional().default('mcp-client'),
  redirect_uris: z.array(z.string().url()).min(1),
});

const AuthorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
  state: z.string().optional().default(''),
  resource: z.string().url().optional(),
  scope: z.string().optional(),
});

const AuthorizePost = AuthorizeQuery.extend({ password: z.string().min(1) });

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): void {
  const now = deps.now ?? Date.now;
  const expectedResource = resourceUri(deps.issuer);

  // ---- discovery ----
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return buildProtectedResourceMetadata(deps.issuer);
  });
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return buildAuthorizationServerMetadata(deps.issuer);
  });

  // ---- DCR (RFC 7591), open with cap+rate-limit ----
  app.post('/oauth/register', async (request, reply) => {
    deps.rateLimiter.consume('oauth-register');
    const parsed = RegisterBody.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_client_metadata', error_description: parsed.error.message };
    }
    let client;
    try {
      client = deps.store.registerClient({
        client_name: parsed.data.client_name,
        redirect_uris: parsed.data.redirect_uris,
        created_at_ms: now(),
      });
    } catch (err) {
      reply.status(429);
      deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'oauth client cap reached');
      return { error: 'temporarily_unavailable', error_description: 'client registration cap reached' };
    }
    reply.status(201);
    return {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  });

  // ---- authorize (GET → login form) ----
  app.get('/oauth/authorize', async (request, reply) => {
    const parsed = AuthorizeQuery.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400).type('text/html');
      return renderError('Invalid authorization request');
    }
    const q = parsed.data;
    const client = deps.store.getClient(q.client_id);
    if (client === undefined || !client.redirect_uris.includes(q.redirect_uri)) {
      reply.status(400).type('text/html');
      return renderError('Unknown client or redirect_uri mismatch');
    }
    if (q.resource !== undefined && q.resource !== expectedResource) {
      reply.status(400).type('text/html');
      return renderError('resource mismatch');
    }
    reply.status(200).type('text/html');
    return renderLoginForm(q);
  });

  // ---- authorize (POST → issue code) ----
  app.post('/oauth/authorize', async (request, reply) => {
    deps.rateLimiter.consume('oauth-authorize');
    const parsed = AuthorizePost.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_request', error_description: parsed.error.message };
    }
    const q = parsed.data;
    const client = deps.store.getClient(q.client_id);
    if (client === undefined || !client.redirect_uris.includes(q.redirect_uri)) {
      reply.status(400);
      return { error: 'invalid_request', error_description: 'redirect_uri mismatch' };
    }
    if (!constantTimeEqual(q.password, deps.authToken)) {
      reply.status(401).type('text/html');
      return renderLoginForm(q, 'Invalid password');
    }
    const code = generateOpaqueToken();
    deps.store.saveCode({
      code_hash: hashToken(code),
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      identity: deps.operatorIdentity,
      scope: q.scope ?? OAUTH_SCOPE,
      resource: expectedResource,
      expires_at_ms: now() + deps.codeTtlSec * 1000,
    });
    const loc = new URL(q.redirect_uri);
    loc.searchParams.set('code', code);
    if (q.state !== '') loc.searchParams.set('state', q.state);
    reply.status(302).header('location', loc.toString());
    return null;
  });

  // ---- token ----
  app.post('/oauth/token', async (request, reply) => {
    deps.rateLimiter.consume('oauth-token');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const grant = body['grant_type'];
    if (grant === 'authorization_code') return handleAuthCodeGrant(body, reply);
    if (grant === 'refresh_token') return handleRefreshGrant(body, reply);
    reply.status(400);
    return { error: 'unsupported_grant_type' };
  });

  // ---- revoke (RFC 7009) ----
  app.post('/oauth/revoke', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body['token'] === 'string' ? body['token'] : undefined;
    if (token !== undefined) deps.store.revokeToken(hashToken(token));
    reply.status(200);
    return {};
  });

  function handleAuthCodeGrant(body: Record<string, unknown>, reply: Parameters<typeof app.post>[1] extends never ? never : import('fastify').FastifyReply) {
    const code = str(body['code']);
    const redirectUri = str(body['redirect_uri']);
    const clientId = str(body['client_id']);
    const verifier = str(body['code_verifier']);
    if (code === undefined || redirectUri === undefined || clientId === undefined || verifier === undefined) {
      reply.status(400);
      return { error: 'invalid_request' };
    }
    const row = deps.store.consumeCode(hashToken(code), now());
    if (row === undefined || row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      reply.status(400);
      return { error: 'invalid_grant' };
    }
    if (!verifyPkceS256(verifier, row.code_challenge)) {
      reply.status(400);
      return { error: 'invalid_grant', error_description: 'PKCE verification failed' };
    }
    return issueTokenPair(row.client_id, row.identity, row.scope, row.resource, generateChainId(), reply);
  }

  function handleRefreshGrant(body: Record<string, unknown>, reply: import('fastify').FastifyReply) {
    const refresh = str(body['refresh_token']);
    const clientId = str(body['client_id']);
    if (refresh === undefined || clientId === undefined) {
      reply.status(400);
      return { error: 'invalid_request' };
    }
    const row = deps.store.consumeRefreshToken(hashToken(refresh), now());
    if (row === undefined || row.client_id !== clientId) {
      reply.status(400);
      return { error: 'invalid_grant' };
    }
    return issueTokenPair(row.client_id, row.identity, row.scope, row.resource, row.refresh_chain_id, reply);
  }

  function issueTokenPair(
    clientId: string, identity: string, scope: string, resource: string, chainId: string,
    reply: import('fastify').FastifyReply,
  ) {
    const access = generateOpaqueToken();
    const refresh = generateOpaqueToken();
    const t = now();
    deps.store.saveToken({
      token_hash: hashToken(access), kind: 'access', client_id: clientId, identity, scope, resource,
      expires_at_ms: t + deps.accessTtlSec * 1000, refresh_chain_id: chainId,
    });
    deps.store.saveToken({
      token_hash: hashToken(refresh), kind: 'refresh', client_id: clientId, identity, scope, resource,
      expires_at_ms: t + deps.refreshTtlSec * 1000, refresh_chain_id: chainId,
    });
    reply.status(200).header('cache-control', 'no-store');
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: deps.accessTtlSec,
      scope,
    };
  }

  function generateChainId(): string {
    return generateOpaqueToken();
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function renderLoginForm(q: z.infer<typeof AuthorizeQuery>, errorMsg?: string): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>slonk · authorize</title></head>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;">
  <h1>Authorize slonk MCP</h1>
  ${errorMsg ? `<p style="color:#b00">${escapeHtml(errorMsg)}</p>` : ''}
  <form method="POST" action="/oauth/authorize">
    ${hidden('response_type', q.response_type)}
    ${hidden('client_id', q.client_id)}
    ${hidden('redirect_uri', q.redirect_uri)}
    ${hidden('code_challenge', q.code_challenge)}
    ${hidden('code_challenge_method', q.code_challenge_method)}
    ${hidden('state', q.state)}
    ${hidden('resource', q.resource ?? '')}
    ${q.scope !== undefined ? hidden('scope', q.scope) : ''}
    <label>Operator password<br><input type="password" name="password" autofocus
      style="width:100%;padding:.5rem;margin:.5rem 0;"></label>
    <button type="submit" style="padding:.5rem 1rem;">Authorize</button>
  </form>
</body></html>`;
}

function renderError(msg: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;">
  <h1>Authorization error</h1><p>${escapeHtml(msg)}</p></body></html>`;
}
```

Note on `RateLimiter.consume`: it takes an identity string; we pass synthetic per-endpoint keys (`oauth-register` etc.) so OAuth traffic gets its own buckets separate from agent identities.

If the inline `import('fastify').FastifyReply` casts read awkwardly to `eslint`, hoist `import type { FastifyReply } from 'fastify';` to the top and use `FastifyReply` directly in the helper signatures.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mcp-kanban && pnpm vitest run src/oauth/routes.test.ts`
Expected: PASS (all flow + negative cases).

- [ ] **Step 6: Typecheck + lint**

Run: `cd mcp-kanban && pnpm typecheck && pnpm lint`
Expected: clean. Fix any `FastifyReply` typing per the note above.

- [ ] **Step 7: Commit**

```bash
git add mcp-kanban/package.json mcp-kanban/pnpm-lock.yaml mcp-kanban/src/oauth/routes.ts mcp-kanban/src/oauth/routes.test.ts
git commit -m "feat(oauth): add discovery, DCR, authorize, token and revoke routes"
```

---

## Task 7: Server wiring + operator identity + log redaction

**Files:**
- Modify: `mcp-kanban/src/server.ts`
- Modify: `mcp-kanban/src/logger.ts`
- Test: `mcp-kanban/src/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `mcp-kanban/src/server.test.ts` a new describe block. It builds a second server with OAuth enabled and exercises discovery + an end-to-end token that then authenticates against `/mcp`'s `/mcp/tools` debug endpoint (cheap auth check without a real Plane call):

```typescript
describe('OAuth-enabled server', () => {
  let oauthBuilt: BuiltServer;
  let oauthTmp: string;

  beforeAll(async () => {
    const config = loadConfig(testEnv({ MCP_OAUTH_ENABLED: '1', MCP_OAUTH_ISSUER: 'https://slonk.example.com' }));
    const logger = createLogger(config);
    oauthTmp = mkdtempSync(join(tmpdir(), 'slonk-oauth-'));
    const idPath = join(oauthTmp, 'identity.sqlite');
    seedIdentityStore(idPath, ALL_ROLES);
    oauthBuilt = await buildServer({
      config, logger,
      identityStorePath: idPath,
      auditStorePath: join(oauthTmp, 'audit.sqlite'),
      gitRefsStorePath: join(oauthTmp, 'git_refs.sqlite'),
      oauthStorePath: join(oauthTmp, 'oauth.sqlite'),
    });
    await oauthBuilt.app.ready();
  });
  afterAll(async () => {
    await oauthBuilt.close();
    rmSync(oauthTmp, { recursive: true, force: true });
  });

  it('exposes protected-resource discovery', async () => {
    const r = await oauthBuilt.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).resource).toBe('https://slonk.example.com/mcp');
  });

  it('accepts an OAuth access token on a protected endpoint as operator', async () => {
    // mint a token directly via the store (the full HTTP dance is covered in routes.test.ts)
    const access = 'integration-access-token';
    oauthBuilt.oauth!.saveToken({
      token_hash: createHash('sha256').update(access).digest('hex'),
      kind: 'access', client_id: 'c', identity: 'operator', scope: 'mcp',
      resource: 'https://slonk.example.com/mcp',
      expires_at_ms: Date.now() + 3600_000, refresh_chain_id: 'ch',
    });
    const r = await oauthBuilt.app.inject({
      method: 'GET', url: '/mcp/tools',
      headers: { authorization: `Bearer ${access}` }, // no X-Agent-Identity needed
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).tools).toContain('who_am_i');
  });
});
```

Add `import { createHash } from 'node:crypto';` to the test file imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-kanban && pnpm vitest run src/server.test.ts -t "OAuth-enabled server"`
Expected: FAIL (`oauthStorePath` / `built.oauth` not defined; discovery 404).

- [ ] **Step 3: Wire the store and routes into `buildServer`**

In `mcp-kanban/src/server.ts`:

Add imports near the top:

```typescript
import formbody from '@fastify/formbody';
import { OAuthStore } from './oauth/store.js';
import { registerOAuthRoutes } from './oauth/routes.js';
import { resourceUri } from './oauth/metadata.js';
```

Add to `BuildServerOptions`:

```typescript
  /** Путь к oauth.sqlite. По умолчанию — общий стор в томе `mcp_data`. */
  oauthStorePath?: string;
```

Add the default path constant near `AUDIT_STORE_DEFAULT_PATH`:

```typescript
export const OAUTH_STORE_DEFAULT_PATH = '/mcp_data/oauth.sqlite';
```

Add `oauth: OAuthStore | undefined;` to `BuiltServer`.

After the `gitRefs` instantiation and before `/health`, build the OAuth store and validator (only when enabled):

```typescript
  const oauth = config.MCP_OAUTH_ENABLED
    ? new OAuthStore({
        path: opts.oauthStorePath ?? config.MCP_OAUTH_STORE_PATH ?? OAUTH_STORE_DEFAULT_PATH,
        maxClients: config.MCP_OAUTH_MAX_CLIENTS,
      })
    : undefined;

  // Валидатор OAuth access-токена для /mcp. Sync (better-sqlite3). Привязка
  // аудитории: токен принимается, только если его resource == наш /mcp.
  const expectedResource = config.MCP_OAUTH_ISSUER !== undefined ? resourceUri(config.MCP_OAUTH_ISSUER) : undefined;
  const oauthValidator =
    oauth !== undefined
      ? (token: string): { identity: AgentIdentity; scope: string } | undefined => {
          const row = oauth.validateAccessToken(hashTokenForAuth(token), Date.now());
          if (row === undefined) return undefined;
          if (expectedResource !== undefined && row.resource !== expectedResource) return undefined;
          return { identity: row.identity, scope: row.scope };
        }
      : undefined;
```

Add a local hashing helper (re-use the oauth crypto to avoid drift). At the top imports add `import { hashToken as hashTokenForAuth } from './oauth/crypto.js';`.

Register OAuth routes when enabled, right after building the app (before `/health` is fine, after `app` is created). Because formbody must be registered before routes parse bodies:

```typescript
  if (oauth !== undefined && config.MCP_OAUTH_ISSUER !== undefined) {
    await app.register(formbody);
    registerOAuthRoutes(app, {
      store: oauth,
      issuer: config.MCP_OAUTH_ISSUER,
      authToken: config.MCP_AUTH_TOKEN,
      operatorIdentity: config.MCP_OAUTH_OPERATOR_IDENTITY,
      accessTtlSec: config.MCP_OAUTH_ACCESS_TTL_SEC,
      refreshTtlSec: config.MCP_OAUTH_REFRESH_TTL_SEC,
      codeTtlSec: config.MCP_OAUTH_CODE_TTL_SEC,
      rateLimiter,
      logger,
    });
  }
```

(Move the `rateLimiter` instantiation above this block if it currently sits below.)

Inject the operator identity into the registry when OAuth is enabled. After `identityRegistry` is built, wrap it:

```typescript
  const effectiveRegistry =
    config.MCP_OAUTH_ENABLED
      ? createIdentityRegistry([...identityRegistry.list(), config.MCP_OAUTH_OPERATOR_IDENTITY])
      : identityRegistry;
```

Use `effectiveRegistry` everywhere `identityRegistry` was passed to `authenticate` (the `/mcp/tools` and `/mcp` handlers).

In both `authenticate(...)` calls (`/mcp/tools` and `/mcp`), add `oauthValidator` to the options object:

```typescript
    authenticate(request, reply, {
      expectedToken: config.MCP_AUTH_TOKEN,
      identityRegistry: effectiveRegistry,
      ...(oauthValidator !== undefined ? { oauthValidator } : {}),
    });
```

(For `/mcp/tools` keep `requireIdentity: false` as-is; the OAuth path sets identity itself and the static path skips identity — both fine.)

Return `oauth` in the `BuiltServer` object and close it in `close()`:

```typescript
    try { oauth?.close(); } catch { /* best-effort */ }
```

Add `oauth,` to the returned object literal.

- [ ] **Step 4: Redact OAuth secrets in logs**

In `mcp-kanban/src/logger.ts`, add to `redact.paths`:

```typescript
        'req.body.password',
        'req.body.code',
        'req.body.code_verifier',
        'req.body.refresh_token',
        'req.body.access_token',
        '*.access_token',
        '*.refresh_token',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mcp-kanban && pnpm vitest run src/server.test.ts`
Expected: PASS (existing + OAuth-enabled describe).

- [ ] **Step 6: Full test + typecheck + lint**

Run: `cd mcp-kanban && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add mcp-kanban/src/server.ts mcp-kanban/src/logger.ts mcp-kanban/src/server.test.ts
git commit -m "feat(oauth): wire OAuth store, routes and operator identity into server"
```

---

## Task 8: Backward-compat guard test (flag off)

**Files:**
- Test: `mcp-kanban/src/server.test.ts`

- [ ] **Step 1: Write the test**

Add to the existing default (flag-off) describe block in `server.test.ts`:

```typescript
  it('does not expose OAuth discovery when the flag is off', async () => {
    const r = await built.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(r.statusCode).toBe(404);
  });

  it('rejects a non-static Bearer when OAuth is off', async () => {
    const r = await built.app.inject({
      method: 'GET', url: '/mcp/tools',
      headers: { authorization: 'Bearer some-oauth-looking-token' },
    });
    expect(r.statusCode).toBe(401);
  });
```

- [ ] **Step 2: Run test**

Run: `cd mcp-kanban && pnpm vitest run src/server.test.ts`
Expected: PASS. (The default `built` server has OAuth off, so discovery is unregistered → Fastify 404, and the unknown Bearer fails the static compare with no validator.)

- [ ] **Step 3: Commit**

```bash
git add mcp-kanban/src/server.test.ts
git commit -m "test(oauth): assert flag-off keeps legacy auth behavior"
```

---

## Task 9: Documentation + .env.example + version bump

No code logic — documentation per project conventions. (Version bump/tag is normally the merger's job, but include the CHANGELOG entry + `.env.example` here so the feature ships documented.)

- [ ] **Step 1: `.env.example`** — add a commented OAuth block:

```bash
# --- OAuth 2.1 Authorization Server (claude.ai remote connector) ---
# Off by default. Enable only when exposing slonk over public HTTPS.
MCP_OAUTH_ENABLED=0
# Public base URL (HTTPS, no trailing slash). Required when MCP_OAUTH_ENABLED=1.
MCP_OAUTH_ISSUER=
# Identity granted to claude.ai sessions (full access, no pipeline column).
MCP_OAUTH_OPERATOR_IDENTITY=operator
MCP_OAUTH_ACCESS_TTL_SEC=3600
MCP_OAUTH_REFRESH_TTL_SEC=2592000
MCP_OAUTH_CODE_TTL_SEC=60
MCP_OAUTH_MAX_CLIENTS=50
# MCP_OAUTH_STORE_PATH=/mcp_data/oauth.sqlite
# Operator password on the login page == MCP_AUTH_TOKEN (no separate secret).
```

- [ ] **Step 2: `docs/SPEC.md`** — in the auth/endpoints section document:
  the new endpoints table (discovery, register, authorize, token, revoke);
  that `/mcp` accepts either the static `MCP_AUTH_TOKEN` (+`X-Agent-Identity`)
  or an OAuth access token (→ `operator`); resource/audience binding; that
  OAuth is gated by `MCP_OAUTH_ENABLED`.

- [ ] **Step 3: `docs/ARCHITECTURE.md`** — add OAuth data flow (discovery →
  DCR → authorize → token → `/mcp`) and threat-model rows: open DCR mitigated
  by operator password + cap + rate-limit; token theft mitigated by refresh
  rotation + chain poisoning; TLS required (external Caddy).

- [ ] **Step 4: `docs/CONFIGURATION.md`** — document each `MCP_OAUTH_*` var,
  defaults, and the HTTPS prerequisite.

- [ ] **Step 5: `docs/ROADMAP.md`** — mark the "Per-agent OAuth-токены" item
  context: claude.ai connector path delivered (operator identity); per-agent
  local OAuth remains future.

- [ ] **Step 6: `docs/CHANGELOG.md`** — add under `[Unreleased] → Added`:
  "Embedded OAuth 2.1 Authorization Server (discovery, DCR, Authorization Code
  + PKCE S256, refresh rotation) for adding slonk as a claude.ai remote
  connector; gated by `MCP_OAUTH_ENABLED` (default off)."

- [ ] **Step 7: `mcp-kanban/package.json`** — bump `version` `1.5.0` → `1.6.0`
  (MINOR: new backward-compatible functionality behind a default-off flag).

- [ ] **Step 8: Commit**

```bash
git add .env.example docs/SPEC.md docs/ARCHITECTURE.md docs/CONFIGURATION.md docs/ROADMAP.md docs/CHANGELOG.md mcp-kanban/package.json
git commit -m "docs(oauth): document embedded OAuth AS and bump to 1.6.0"
```

---

## Final verification

- [ ] Run the whole suite + checks: `cd mcp-kanban && pnpm test && pnpm typecheck && pnpm lint`
- [ ] Build the Docker image: `make build` (from repo root) — confirms `@fastify/formbody` resolves in the production multi-stage build.
- [ ] Manual smoke (optional, requires a public HTTPS endpoint): set `MCP_OAUTH_ENABLED=1` + `MCP_OAUTH_ISSUER`, `make up`, then `curl https://<host>/.well-known/oauth-protected-resource` returns the metadata.

---

## Self-Review notes (author)

- **Spec coverage:** discovery (Task 4/6), DCR (Task 6), authorize+PKCE (Task 6), token+rotation (Tasks 3/6), opaque+SQLite store (Task 3), operator identity (Task 7), reuse `MCP_AUTH_TOKEN` as operator password (Task 6), `/mcp` dual-auth (Task 5/7), config flag + issuer refine (Task 1), security (constant-time, hashing, rate-limit, cap, resource binding — Tasks 2/3/6/7), redaction (Task 7), flag-off compat (Task 8), docs + version (Task 9). No gaps.
- **Deviation from spec:** the spec mentioned caching OAuth validation via `TtlCache`. Dropped for correctness/simplicity — `better-sqlite3` PK lookups are sub-millisecond and direct validation avoids revoke staleness. Recorded here; update the spec note if desired.
- **Type consistency:** `OAuthStore` method names (`registerClient`, `getClient`, `saveCode`, `consumeCode`, `saveToken`, `validateAccessToken`, `consumeRefreshToken`, `poisonChain`, `revokeToken`) are used identically across Tasks 3/6/7. `hashToken`/`generateOpaqueToken`/`verifyPkceS256`/`constantTimeEqual` from `crypto.ts` used consistently. `oauthValidator` signature matches between `auth.ts` (Task 5) and `server.ts` (Task 7).
