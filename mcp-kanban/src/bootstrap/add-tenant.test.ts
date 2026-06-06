import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { addTenantCli } from './add-tenant.js';
import { OAuthStore } from '../oauth/store.js';
import { hashToken } from '../oauth/crypto.js';

function memOutput(): { stream: Writable; text(): string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

function memInput(lines: readonly string[]): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    for (const l of lines) {
      stream.write(`${l}\n`);
    }
  });
  return stream;
}

describe('addTenantCli', () => {
  let store: OAuthStore;
  const now = 1_700_000_000_000;

  beforeEach(() => {
    // Один in-memory стор, переиспользуемый внутри теста (DI). Между тестами
    // — новый, чтобы не текло состояние.
    store = new OAuthStore({ path: ':memory:', maxClients: 5 });
  });
  afterEach(() => store.close());

  it('registers a tenant from flags with an explicit password (non-interactive)', async () => {
    const out = memOutput();
    const res = await addTenantCli({
      store,
      now: () => now,
      output: out.stream,
      argv: ['--workspace', 'acme', '--plane-api-key', 'plane_api_xxx', '--password', 'S3cret-pass'],
    });

    expect(res).toEqual({ workspace: 'acme', created: true });
    expect(res.generatedPassword).toBeUndefined();

    const row = store.getTenantByWorkspace('acme');
    expect(row).toBeDefined();
    expect(row!.plane_api_key).toBe('plane_api_xxx');
    expect(row!.auth_token_hash).toBe(hashToken('S3cret-pass'));
    expect(row!.created_at_ms).toBe(now);
  });

  it('generates a password when none is given and records its hash', async () => {
    const out = memOutput();
    const res = await addTenantCli({
      store,
      now: () => now,
      output: out.stream,
      argv: ['--workspace', 'acme', '--plane-api-key', 'plane_api_xxx'],
    });

    expect(res.created).toBe(true);
    expect(res.generatedPassword).toBeDefined();
    expect(res.generatedPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = store.getTenantByWorkspace('acme')!;
    expect(row.auth_token_hash).toBe(hashToken(res.generatedPassword!));
  });

  it('is idempotent: re-running updates key/password in place and reports updated', async () => {
    await addTenantCli({
      store,
      now: () => now,
      output: memOutput().stream,
      argv: ['--workspace', 'acme', '--plane-api-key', 'key-v1', '--password', 'first-pass'],
    });
    const res2 = await addTenantCli({
      store,
      now: () => now + 1,
      output: memOutput().stream,
      argv: ['--workspace', 'acme', '--plane-api-key', 'key-v2', '--password', 'second-pass'],
    });

    expect(res2.created).toBe(false);
    expect(store.listTenants()).toHaveLength(1);
    const row = store.getTenantByWorkspace('acme')!;
    expect(row.plane_api_key).toBe('key-v2');
    expect(row.auth_token_hash).toBe(hashToken('second-pass'));
  });

  it('collects fields interactively and generates a password on empty input', async () => {
    const out = memOutput();
    const res = await addTenantCli({
      store,
      now: () => now,
      output: out.stream,
      input: memInput(['team-1', 'plane_api_interactive', '']),
    });

    expect(res.workspace).toBe('team-1');
    expect(res.created).toBe(true);
    expect(res.generatedPassword).toBeDefined();
    const row = store.getTenantByWorkspace('team-1')!;
    expect(row.plane_api_key).toBe('plane_api_interactive');
  });

  it('passes through --max-clients into registerTenant', async () => {
    await addTenantCli({
      store,
      now: () => now,
      output: memOutput().stream,
      argv: ['--workspace', 'acme', '--plane-api-key', 'k', '--password', 'pw-eight1', '--max-clients', '99'],
    });
    expect(store.getTenantByWorkspace('acme')!.max_clients).toBe(99);
  });

  it('rejects an invalid workspace slug', async () => {
    await expect(
      addTenantCli({
        store,
        output: memOutput().stream,
        argv: ['--workspace', 'Acme Corp', '--plane-api-key', 'k', '--password', 'pw-eight1'],
      }),
    ).rejects.toThrow(/slug/i);
  });

  it('rejects a too-short manual password', async () => {
    await expect(
      addTenantCli({
        store,
        output: memOutput().stream,
        argv: ['--workspace', 'acme', '--plane-api-key', 'k', '--password', 'short'],
      }),
    ).rejects.toThrow(/at least 8/);
  });

  it('rejects an empty plane api key', async () => {
    await expect(
      addTenantCli({
        store,
        output: memOutput().stream,
        argv: ['--workspace', 'acme', '--plane-api-key', '', '--password', 'pw-eight1'],
      }),
    ).rejects.toThrow();
  });

  it('rejects unknown arguments with usage', async () => {
    await expect(
      addTenantCli({ store, output: memOutput().stream, argv: ['--bogus', 'x'] }),
    ).rejects.toThrow(/Unknown argument/);
  });

  it('never echoes the plane api key, and prints a generated password exactly once', async () => {
    const out = memOutput();
    const res = await addTenantCli({
      store,
      now: () => now,
      output: out.stream,
      argv: ['--workspace', 'acme', '--plane-api-key', 'super-secret-key'],
    });
    const text = out.text();
    expect(text).not.toContain('super-secret-key');
    // Сгенерированный пароль печатается ровно один раз.
    const occurrences = text.split(res.generatedPassword!).length - 1;
    expect(occurrences).toBe(1);
  });

  it('never echoes an explicit password back to output', async () => {
    const out = memOutput();
    await addTenantCli({
      store,
      now: () => now,
      output: out.stream,
      argv: ['--workspace', 'acme', '--plane-api-key', 'k', '--password', 'my-explicit-pass'],
    });
    expect(out.text()).not.toContain('my-explicit-pass');
  });
});
