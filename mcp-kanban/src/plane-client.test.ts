import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { PlaneClient } from './plane-client.js';
import { PlaneError } from './errors.js';

const silent = pino({ level: 'silent' });

interface ClientHarness {
  client: PlaneClient;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  sleeps: number[];
}

function makeClient(
  responses: Array<Response | (() => Response | Promise<Response>) | Error>,
  cfgOverrides: Partial<{
    MCP_RETRY_ATTEMPTS: number;
    MCP_RETRY_ATTEMPTS_429: number;
    MCP_RETRY_BACKOFF_MS: number;
  }> = {},
): ClientHarness {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sleeps: number[] = [];
  let i = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses[i];
    i += 1;
    if (next === undefined) throw new Error(`fakeFetch ran out of responses (call ${i})`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;

  const client = new PlaneClient({
    config: {
      PLANE_API_BASE_URL: 'http://plane-api/api/v1/',
      PLANE_API_KEY: 'k',
      MCP_PLANE_TIMEOUT_MS: 5_000,
      MCP_RETRY_ATTEMPTS: cfgOverrides.MCP_RETRY_ATTEMPTS ?? 3,
      MCP_RETRY_ATTEMPTS_429: cfgOverrides.MCP_RETRY_ATTEMPTS_429 ?? 10,
      MCP_RETRY_BACKOFF_MS: cfgOverrides.MCP_RETRY_BACKOFF_MS ?? 10,
    },
    logger: silent,
    hooks: {
      fetch: fakeFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      now: () => 0,
    },
  });
  return { client, calls, sleeps };
}

function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('PlaneClient.request — 429 handling', () => {
  it('retries on 429 with backoff and succeeds when Plane recovers', async () => {
    const { client, calls, sleeps } = makeClient([
      jsonResp(429, { error_code: 5900, error_message: 'RATE_LIMIT_EXCEEDED' }),
      jsonResp(429, { error_code: 5900, error_message: 'RATE_LIMIT_EXCEEDED' }),
      jsonResp(200, { id: 'p1' }),
    ]);
    const res = await client.request<{ id: string }>('workspaces/agents/projects/');
    expect(res).toEqual({ id: 'p1' });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    // backoff capped to ≥ 1s for 429
    expect(sleeps.every((ms) => ms >= 1000)).toBe(true);
  });

  it('honors Retry-After header (seconds)', async () => {
    const { client, sleeps } = makeClient([
      jsonResp(429, { error: 'slow down' }, { 'retry-after': '7' }),
      jsonResp(200, { ok: true }),
    ]);
    await client.request('workspaces/agents/projects/');
    expect(sleeps).toEqual([7_000]);
  });

  it('throws PlaneError with planeStatus=429 and human-readable message after exhausting retries', async () => {
    const { client, calls } = makeClient(
      Array(5).fill(jsonResp(429, { error: 'RATE_LIMIT_EXCEEDED' })),
      { MCP_RETRY_ATTEMPTS_429: 3 },
    );
    let caught: unknown;
    try {
      await client.request('workspaces/agents/projects/');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlaneError);
    const err = caught as PlaneError;
    expect(err.planeStatus).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toMatch(/rate limit/i);
    expect(err.message).toMatch(/PLANE_API_KEY_RATE_LIMIT/);
    expect(err.message).toMatch(/bootstrap is idempotent/);
    // attempts429=3 → 4 total attempts (initial + 3 retries) before throw
    expect(calls).toHaveLength(4);
  });

  it('uses separate budget from 5xx retries', async () => {
    // MCP_RETRY_ATTEMPTS=2 (5xx), but for 429 still allows up to 10.
    const { client, calls } = makeClient(
      [
        ...Array(5).fill(jsonResp(429, {})),
        jsonResp(200, { ok: true }),
      ],
      { MCP_RETRY_ATTEMPTS: 2, MCP_RETRY_ATTEMPTS_429: 10 },
    );
    await client.request('workspaces/agents/projects/');
    expect(calls).toHaveLength(6);
  });

  it('still retries 5xx independently and throws on exhaustion', async () => {
    const { client, calls } = makeClient(
      [
        jsonResp(500, {}),
        jsonResp(500, {}),
        jsonResp(500, {}),
        jsonResp(500, {}),
      ],
      { MCP_RETRY_ATTEMPTS: 2 },
    );
    await expect(client.request('workspaces/agents/projects/')).rejects.toBeInstanceOf(PlaneError);
    // 1 initial + 2 retries = 3 calls before throwing on the 3rd 500.
    expect(calls).toHaveLength(3);
  });
});

// SLONK-5: getIssueBySequenceId раньше делал `?per_page=500` на каждый
// lookup `SLONK-N`. Это сериализовало сотни PlaneIssue (с description_html)
// и било по памяти на маленьком хосте. Теперь — постраничный сканер с
// early-exit и `per_page=50`.
describe('PlaneClient.getIssueBySequenceId — paginated early-exit (SLONK-5)', () => {
  function issue(seq: number): Record<string, unknown> {
    return {
      id: `uuid-${seq}`,
      sequence_id: seq,
      name: `Task ${seq}`,
      state: 'st',
      created_at: '2026-05-14T00:00:00Z',
      updated_at: '2026-05-14T00:00:00Z',
      project: 'proj-1',
    };
  }

  it('hits the first page when the requested sequence is in it (early-exit)', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => issue(100 - i));
    // Найдём seq=80 — он в первой странице (от 100 до 51). Должен быть ровно
    // 1 HTTP-запрос, никакой второй страницы.
    const { client, calls } = makeClient([
      jsonResp(200, { results: firstPage, next: 'cursor-2' }),
    ]);
    const got = await client.getIssueBySequenceId('agents', 'proj-1', 'SLONK', 80);
    expect(got?.sequence_id).toBe(80);
    expect(calls).toHaveLength(1);
    // Per-page подставился = 50 (а не legacy 500).
    expect(calls[0]?.url).toMatch(/per_page=50/);
  });

  it('paginates with cursor when sequence is not in first page', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => issue(200 - i));    // 200..151
    const page2 = Array.from({ length: 50 }, (_, i) => issue(150 - i));    // 150..101
    const { client, calls } = makeClient([
      jsonResp(200, { results: page1, next: 'c2' }),
      jsonResp(200, { results: page2, next: null }),
    ]);
    const got = await client.getIssueBySequenceId('agents', 'proj-1', 'SLONK', 110);
    expect(got?.sequence_id).toBe(110);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toMatch(/cursor=c2/);
  });

  it('returns undefined when sequence not found and pagination ends', async () => {
    const { client, calls } = makeClient([
      jsonResp(200, { results: [issue(10), issue(9)], next: null }),
    ]);
    const got = await client.getIssueBySequenceId('agents', 'proj-1', 'SLONK', 999);
    expect(got).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('handles legacy non-paginated array shape', async () => {
    const { client, calls } = makeClient([
      jsonResp(200, [issue(3), issue(2), issue(1)]),
    ]);
    const got = await client.getIssueBySequenceId('agents', 'proj-1', 'SLONK', 2);
    expect(got?.sequence_id).toBe(2);
    expect(calls).toHaveLength(1);
  });
});
