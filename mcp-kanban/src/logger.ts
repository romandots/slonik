import pino, { destination, multistream, stdTimeFunctions } from 'pino';
import type { Logger, LoggerOptions } from 'pino';
import type { Config } from './config.js';

export type { Logger };

export function createLogger(config: Pick<Config, 'MCP_LOG_LEVEL' | 'MCP_LOG_FILE' | 'NODE_ENV'>): Logger {
  const baseOpts: LoggerOptions = {
    level: config.MCP_LOG_LEVEL,
    base: { service: 'mcp-kanban' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-agent-identity"]',
        '*.MCP_AUTH_TOKEN',
        '*.PLANE_API_KEY',
        '*.POSTGRES_PASSWORD',
        '*.MINIO_ROOT_PASSWORD',
        '*.MINIO_SECRET_KEY',
        // Presigned URL'ы содержат `X-Amz-Signature` — короткоживущий, но
        // всё равно секретный credential. Никогда не логируем ни как
        // отдельное поле, ни в составе chained-объектов: вместо URL пишем
        // {bucket, object_key, expires_at}.
        //
        // Pino-redact: wildcard `*.foo` матчит ТОЛЬКО nested-варианты
        // (`{ctx:{foo:...}}`), top-level `{foo:...}` остаётся открытым.
        // Поэтому держим обе формы — голое имя поля для top-level и
        // `*.foo` для одноуровневой вложенности (см. pino #1561).
        'download_url',
        'upload_url',
        'presigned_url',
        '*.download_url',
        '*.upload_url',
        '*.presigned_url',
      ],
      remove: true,
    },
  };

  if (config.MCP_LOG_FILE) {
    return pino(
      baseOpts,
      multistream([
        { stream: destination({ dest: 1, sync: false }) },
        { stream: destination({ dest: config.MCP_LOG_FILE, sync: false, mkdir: true }) },
      ]),
    );
  }

  return pino(baseOpts);
}
