import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { RealMinioClient } from './minio-client.js';

const silent = pino({ level: 'silent' });

type ClientCfg = Parameters<typeof RealMinioClient.prototype.constructor>[0]['config'];

function build(cfg: Partial<ClientCfg>): RealMinioClient {
  return new RealMinioClient({
    logger: silent,
    config: {
      MINIO_INTERNAL_ENDPOINT: 'http://minio:9000',
      MINIO_PUBLIC_ENDPOINT: 'https://minio.example.com',
      MINIO_ACCESS_KEY: 'key',
      MINIO_SECRET_KEY: 'secret',
      MINIO_USE_SSL: false,
      ...cfg,
    } as ClientCfg,
  });
}

// minio SDK Client хранит схему в `.protocol` ('http:' / 'https:').
function protocolOf(client: RealMinioClient, which: 'internalClient' | 'publicClient'): string {
  return (client as unknown as Record<string, { protocol: string }>)[which].protocol;
}

describe('RealMinioClient SSL resolution (SLONK-23)', () => {
  it('internal client derives TLS strictly from MINIO_INTERNAL_ENDPOINT, ignoring MINIO_USE_SSL', () => {
    // Регрессия SLONK-23: при MINIO_USE_SSL=1 internal-клиент НЕ должен лезть по
    // HTTPS на plaintext `http://minio:9000` (иначе ssl3_get_record:wrong version).
    const client = build({ MINIO_USE_SSL: true });
    expect(protocolOf(client, 'internalClient')).toBe('http:');
  });

  it('public client honours MINIO_USE_SSL for presign even if endpoint scheme is plaintext', () => {
    const client = build({
      MINIO_PUBLIC_ENDPOINT: 'http://minio.example.com:9000',
      MINIO_USE_SSL: true,
    });
    expect(protocolOf(client, 'publicClient')).toBe('https:');
  });

  it('public client uses TLS when the endpoint scheme is https', () => {
    const client = build({ MINIO_USE_SSL: false });
    expect(protocolOf(client, 'publicClient')).toBe('https:');
  });

  it('internal client uses TLS when MINIO_INTERNAL_ENDPOINT itself is https', () => {
    const client = build({ MINIO_INTERNAL_ENDPOINT: 'https://minio:443', MINIO_USE_SSL: false });
    expect(protocolOf(client, 'internalClient')).toBe('https:');
  });
});
