// Загрузка байтов в S3/MinIO через presigned POST, выданный Plane
// (`GenericAssetEndpoint.upload_data`). Это НЕ Plane API и НЕ MinIO SDK —
// presigned POST это multipart/form-data на `upload_data.url` с заранее
// подписанными `upload_data.fields`, поэтому шлём обычным fetch + FormData.
// Вынесено за интерфейс, чтобы handler `embed_image` юнит-тестировался без сети.

import { McpError } from './errors.js';

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export interface AssetUploader {
  /**
   * Выполняет presigned S3 POST. Поля подписи идут первыми, файл — последним
   * (требование S3 POST policy: `file` должен быть последним полем формы).
   * Бросает `McpError(STORAGE_UNAVAILABLE)` на не-2xx или сетевую ошибку.
   */
  upload(
    uploadData: PresignedPost,
    content: Buffer,
    contentType: string,
    filename: string,
  ): Promise<void>;
}

export interface FetchAssetUploaderOpts {
  /** Инъекция fetch для тестов; по умолчанию глобальный fetch (Node 22). */
  fetch?: typeof fetch;
  /** Таймаут запроса, мс. */
  timeoutMs?: number;
}

export function createFetchAssetUploader(opts: FetchAssetUploaderOpts = {}): AssetUploader {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    async upload(uploadData, content, contentType, filename) {
      const form = new FormData();
      // Подписанные поля — строго до файла.
      for (const [key, value] of Object.entries(uploadData.fields)) {
        form.append(key, value);
      }
      const blob = new Blob([new Uint8Array(content)], { type: contentType });
      form.append('file', blob, filename);

      let resp: Response;
      try {
        resp = await doFetch(uploadData.url, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new McpError({
          code: 'STORAGE_UNAVAILABLE',
          message: `presigned upload to object storage failed: ${msg}`,
          cause: err,
        });
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new McpError({
          code: 'STORAGE_UNAVAILABLE',
          message: `presigned upload rejected: ${resp.status} ${text.slice(0, 200)}`,
        });
      }
    },
  };
}
