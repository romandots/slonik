import { Client as MinioSdkClient } from 'minio';
import type { Logger } from './logger.js';
import type { Config } from './config.js';
import { McpError } from './errors.js';

// Тонкая обёртка над `minio` npm SDK. Контракт узкий: только те операции,
// которые реально нужны для read_attachment / list_attachments
// (SLONK-14). Запись (presignedPutObject и т.п.) намеренно отсутствует —
// write-side `attach_file` остаётся v1-stub'ом до отдельной задачи.
//
// Все ошибки SDK заворачиваем в `McpError({code: 'STORAGE_UNAVAILABLE'})`,
// 404 на `statObject` — в `NOT_FOUND`. Это даёт хендлерам единый
// обработчик: catch McpError, mapping не нужен.

export interface MinioStat {
  size: number;
  etag?: string;
  lastModified?: Date;
  metaData?: Record<string, string>;
  contentType?: string;
}

export interface MinioObject {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

/**
 * Контракт MinIO-клиента, который потребляют tool'ы. Production-импл —
 * `RealMinioClient` (поверх `minio` SDK); тестовая — `FakeMinioClient`
 * (в `tools/test-fakes.ts`).
 *
 * Метод `presignedGetObject` возвращает временный URL. Контракт: получатель
 * этого URL делает обычный HTTP GET без дополнительных заголовков.
 * Срок жизни — `expirySec`.
 */
export interface MinioClient {
  statObject(bucket: string, objectKey: string): Promise<MinioStat>;
  presignedGetObject(bucket: string, objectKey: string, expirySec: number): Promise<string>;
  listObjectsV2(bucket: string, prefix: string): Promise<MinioObject[]>;
  /** Health-check: возвращает true, если MinIO доступен (для /health). */
  checkHealth(): Promise<boolean>;
}

/**
 * Реальный клиент поверх `minio` SDK. Адресует `MINIO_PUBLIC_ENDPOINT`
 * для presign (URL'ы пойдут наружу docker-сети) и `MINIO_INTERNAL_ENDPOINT`
 * для stat/list (server-to-server).
 */
export class RealMinioClient implements MinioClient {
  private readonly publicClient: MinioSdkClient;
  private readonly internalClient: MinioSdkClient;
  private readonly log: Logger;

  constructor(opts: {
    config: Pick<
      Config,
      'MINIO_PUBLIC_ENDPOINT' | 'MINIO_INTERNAL_ENDPOINT' | 'MINIO_ACCESS_KEY' | 'MINIO_SECRET_KEY' | 'MINIO_USE_SSL'
    >;
    logger: Logger;
  }) {
    this.log = opts.logger.child({ component: 'minio-client' });
    const internal = parseEndpoint(opts.config.MINIO_INTERNAL_ENDPOINT);
    // Public endpoint используется только для presign. Если не задан —
    // fallback на INTERNAL (агент с хоста должен иметь route до docker
    // bridge: `localhost:9000`).
    const publicEndpoint =
      opts.config.MINIO_PUBLIC_ENDPOINT !== undefined && opts.config.MINIO_PUBLIC_ENDPOINT.length > 0
        ? parseEndpoint(opts.config.MINIO_PUBLIC_ENDPOINT)
        : internal;
    const accessKey = opts.config.MINIO_ACCESS_KEY ?? '';
    const secretKey = opts.config.MINIO_SECRET_KEY ?? '';
    this.publicClient = new MinioSdkClient({
      endPoint: publicEndpoint.host,
      port: publicEndpoint.port,
      useSSL: publicEndpoint.useSSL,
      accessKey,
      secretKey,
    });
    this.internalClient = new MinioSdkClient({
      endPoint: internal.host,
      port: internal.port,
      useSSL: internal.useSSL || opts.config.MINIO_USE_SSL,
      accessKey,
      secretKey,
    });
  }

  async statObject(bucket: string, objectKey: string): Promise<MinioStat> {
    try {
      const stat = await this.internalClient.statObject(bucket, objectKey);
      return {
        size: stat.size,
        ...(stat.etag !== undefined ? { etag: stat.etag } : {}),
        ...(stat.lastModified !== undefined ? { lastModified: stat.lastModified } : {}),
        ...(stat.metaData !== undefined ? { metaData: stat.metaData as Record<string, string> } : {}),
        ...(stat.metaData?.['content-type'] !== undefined
          ? { contentType: stat.metaData['content-type'] }
          : {}),
      };
    } catch (err) {
      throw mapMinioError(err, `statObject(${bucket}, ${objectKey})`);
    }
  }

  async presignedGetObject(bucket: string, objectKey: string, expirySec: number): Promise<string> {
    try {
      // SDK подписывает URL для endpoint'а, прописанного при инициализации,
      // — поэтому presign идёт через `publicClient` (внешний URL).
      return await this.publicClient.presignedGetObject(bucket, objectKey, expirySec);
    } catch (err) {
      throw mapMinioError(err, `presignedGetObject(${bucket}, ${objectKey})`);
    }
  }

  async listObjectsV2(bucket: string, prefix: string): Promise<MinioObject[]> {
    try {
      const out: MinioObject[] = [];
      const stream = this.internalClient.listObjectsV2(bucket, prefix, true);
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (obj) => {
          if (obj.name === undefined) return;
          out.push({
            key: obj.name,
            size: obj.size ?? 0,
            ...(obj.lastModified !== undefined ? { lastModified: obj.lastModified } : {}),
            ...(obj.etag !== undefined ? { etag: obj.etag } : {}),
          });
        });
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve());
      });
      return out;
    } catch (err) {
      throw mapMinioError(err, `listObjectsV2(${bucket}, ${prefix})`);
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.internalClient.listBuckets();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: msg }, 'MinIO health probe failed');
      return false;
    }
  }
}

interface ParsedEndpoint {
  host: string;
  port: number;
  useSSL: boolean;
}

/**
 * Конвертация `http://minio:9000` / `https://s3.example:443` в формат,
 * который ожидает minio SDK (host без схемы + отдельный port + флаг SSL).
 * Невалидный URL → throw на этапе boot (config-validation такие не пропустит,
 * но fallback на throw оставляем).
 */
function parseEndpoint(url: string): ParsedEndpoint {
  const u = new URL(url);
  const useSSL = u.protocol === 'https:';
  const port = u.port !== '' ? Number.parseInt(u.port, 10) : useSSL ? 443 : 80;
  return { host: u.hostname, port, useSSL };
}

interface MinioErrorLike {
  code?: string;
  statusCode?: number;
  message?: string;
}

/**
 * MinIO SDK ошибки несут `code` ('NoSuchKey', 'NotFound') и `statusCode`
 * (404/403/...). Маппим в McpError так, чтобы хендлеры могли отличить
 * «файл удалён» от «MinIO лёг». 404/NoSuchKey/NotFound → NOT_FOUND,
 * остальное → STORAGE_UNAVAILABLE.
 */
function mapMinioError(err: unknown, ctx: string): McpError {
  const e = err as MinioErrorLike;
  const status = e?.statusCode;
  const code = e?.code;
  const message = e?.message ?? String(err);
  if (status === 404 || code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchBucket') {
    return new McpError({
      code: 'NOT_FOUND',
      message: `MinIO object not found (${ctx}): ${message}`,
      cause: err,
    });
  }
  return new McpError({
    code: 'STORAGE_UNAVAILABLE',
    message: `MinIO unavailable (${ctx}): ${message}`,
    cause: err,
  });
}
