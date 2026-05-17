# Design — Reading attachments via MCP

**Date:** 2026-05-17
**Status:** Final, implemented in SLONK-14 (Analysis → Development → Security Review → Code Review → Testing accepted; pending merge to `develop`).
**Scope:** Read-side only (`list_attachments`, `read_attachment`, `get_issue` preview). Write-side (`attach_file`) — out of scope, parity tracked separately.

## 1. Контекст и проблема

Сегодня MCP-агенты не могут прочитать содержимое файлов, приложенных к
задаче или комментарию. В `PlaneClient` нет ни одного метода для работы с
`/issue-attachments/`. Tool `attach_file` существует, но он односторонний
(upload, причём в v1-stub варианте) и ничего не отдаёт обратно.

В то же время файлы лежат в двух разных хранилищах:

- **`plane-uploads`** (bucket Plane): сюда складывается всё, что человек
  приложил через UI Plane — секция Attachments на карточке + inline-ассеты
  (drag-drop картинок в тело комментария).
- **`mcp-artifacts`** (bucket MCP): сюда `attach_file complete` сохраняет
  ключ объекта и публикует raw-URL в комментарии. Самого файла больше
  нигде не отслеживается — связь «issue → артефакт» восстанавливается
  только по object-key prefix `issues/<id>/`.

Задача: дать агентам единый, безопасный, ergonomic интерфейс для чтения
любого файла, приложенного к задаче, независимо от того, кто и как его
туда положил.

## 2. Цели и не-цели

**Цели**

- Агент видит, какие файлы есть на задаче (включая inline-ассеты в
  комментариях и агентские артефакты из `mcp-artifacts`).
- Агент получает временный URL для скачивания конкретного файла, по
  которому может сделать обычный HTTP GET.
- Чтения логируются в audit (кто, что, когда) — отдельная запись на
  каждый `read_attachment`.
- Project scoping и identity-rate-limit работают так же, как для
  остальных write-tool'ов.

**Не-цели (v1)**

- Не чиним write-side `attach_file` (v1-stub остаётся как есть; парный
  «настоящий presigned PUT» делается отдельной задачей).
- Не возвращаем содержимое файлов inline через MCP — только presigned
  GET URL.
- Не строим persistent индекс вложений (SQLite mirror) — каждый list
  читает источники свежо через 10s TTL-кэш.
- Не делаем content-dedup по sha256.
- Не парсим `description_html` тела задачи на inline-картинки (только
  comments). Future work.
- Не разделяем service-account creds MinIO на read/write — один root,
  единый bucket-access. Полная разделённая policy — отдельная фаза
  вместе с Phase 7 (TLS).

## 3. Поверхность контракта

Три точки в API.

### 3.1. Расширение `get_issue`

К существующему ответу `get_issue` добавляются два поля:

```ts
attachments_count: number;          // total across all sources
attachments_preview: Attachment[];  // up to 3, sorted by uploaded_at DESC
```

Изменение обратносовместимое: клиенты, которые поля не читают, не
ломаются. Preview работает через тот же source-сбор, что и
`list_attachments`, но с `limit=3` и без cursor'а.

### 3.2. Новый tool `list_attachments`

Read-only, прокачивается через TTL-кэш (`ttl=10s`, ключ инкорпорирует
issue_id + фильтры).

```ts
input: {
  issue_id: string;                 // PROJ-N или uuid
  project?: string;                 // override default project
  source?: 'plane_issue' | 'plane_comment_inline' | 'mcp_artifact' | 'all';
                                    // default 'all'
  comment_id?: string;              // filter to a specific comment
  since?: string;                   // ISO8601, attachments uploaded_at >= since
  limit?: number;                   // default 50, max 200
  cursor?: string;                  // opaque pagination cursor
}

output: {
  items: Attachment[];
  next_cursor?: string;             // present iff more results available
  total: number;                    // pre-pagination total across all sources
  partial: boolean;                 // true if any source failed; default false
}
```

### 3.3. Новый tool `read_attachment`

Write-tool с точки зрения audit (одна запись на вызов), но без побочных
эффектов в Plane.

```ts
input: {
  issue_id: string;
  attachment_id: string;            // id из list_attachments
  project?: string;
}

output: {
  download_url: string;             // presigned MinIO GET URL
  method: 'GET';
  required_headers: Record<string, string>;   // обычно пусто
  expires_in: number;               // seconds, из PLANE_SIGNED_URL_EXPIRATION
  mime_type: string;
  size: number;
  filename: string;
  source: AttachmentSource;
}
```

Контракт: «если вернули URL — файл точно существует на момент ответа».
Реализуется через `statObject` перед presign.

## 4. Унифицированный record `Attachment`

### 4.1. Форма

```ts
type AttachmentSource = 'plane_issue' | 'plane_comment_inline' | 'mcp_artifact';

interface Attachment {
  id: string;                       // см. §4.2 — self-describing prefix
  source: AttachmentSource;
  filename: string;
  mime_type: string;
  size: number;
  uploaded_at: string;              // ISO8601, UTC
  uploaded_by?: string;             // identity (mcp_artifact) или
                                    // Plane user display name (plane_*)
  comment_id?: string;              // для plane_comment_inline и mcp_artifact

  // НЕ сериализуется наружу, только во внутренних типах:
  storage: {
    bucket: string;
    object_key: string;
  };
}
```

Поле `storage` остаётся внутри MCP — клиент видит только абстрактный
`id`. Это разрывает coupling между tool-контрактом и физическим
расположением файла: смена layout'а bucket'а не ломает внешний API.

### 4.2. Схема `id`

Self-describing prefix позволяет резолверу понять, в какой источник идти,
без обращения к индексу:

| Source | Формат `id` |
|---|---|
| `plane_issue` | `pi_<plane_attachment_id>` (id в той форме, в какой Plane его возвращает — обычно UUID) |
| `plane_comment_inline` | `pci_<comment_uuid>_<sha1(asset_url)[:12]>` |
| `mcp_artifact` | `mca_<sha1(object_key)[:16]>` |

В коде — `parseAttachmentId(id) → { source, payload }`, единая точка
валидации. Невалидный id → `INVALID_INPUT`.

Хэшированный suffix у `pci_` и `mca_` решает две задачи: (а) короче, чем
сырой URL/key; (б) не раскрывает внутренние пути в id, который потенциально
светится в логах и аудите.

**Reverse-resolution `id → storage` в `read_attachment`** (stateless):
- `pi_*` → прямой вызов Plane API с `attachment_id`, получаем `asset` →
  object_key.
- `pci_*` → `listIssueComments(issueId)` → находим comment по `comment_uuid`
  → парсим HTML → находим asset с матчем `sha1(url)[:12]`. Скоуп ограничен
  одной задачей.
- `mca_*` → `listObjectsV2('mcp-artifacts', 'issues/<issueId>/')` →
  пробегаем, считаем `sha1(key)[:16]`, находим матч. Скоуп ограничен
  префиксом одной задачи.

То есть `read_attachment` фактически повторяет часть discovery для своей
группы источников. Это допустимо для v1: discovery дешёвый (одна задача
= десятки файлов максимум), а stateless-резолвер не требует
session-кэша/инвалидации.

### 4.3. Сортировка и дедупликация

`list_attachments` сортирует по `uploaded_at DESC`. Если один и тот же
физический файл попадает в два источника одновременно — две разные
записи с разными id, не схлопываем. Content-dedup по sha256 — отдельная
задача.

## 5. Discovery — как читается каждый источник

Все три источника читаются параллельно (`Promise.all`); результаты
сливаются, сортируются, пагинируются. На уровне `list_attachments`
любая ошибка отдельного источника логируется как warning и возвращается
как `partial: true` (см. §6), остальные источники продолжают работать.

### 5.1. `plane_issue` — через Plane API

Новый метод `PlaneClient.listIssueAttachments(workspaceSlug, projectId,
issueId)`. Endpoint Plane v1.3.0:

```
GET /api/v1/workspaces/{slug}/projects/{pid}/issues/{iid}/issue-attachments/
```

Ответ содержит: `id`, `attributes.name`, `attributes.size`,
`attributes.type` (mime), `asset` (object_key в `plane-uploads`),
`created_at`, `created_by`. Маппинг прямой:

| Plane field | Attachment field |
|---|---|
| `id` | `id` после `pi_` префикса |
| `attributes.name` | `filename` |
| `attributes.size` | `size` |
| `attributes.type` | `mime_type` |
| `asset` | `storage.object_key` (bucket = `MINIO_BUCKET_PLANE`) |
| `created_at` | `uploaded_at` |
| `created_by` (lookup → user display_name) | `uploaded_by` |

### 5.2. `plane_comment_inline` — парс HTML комментариев

`listIssueComments` уже есть. Для каждого comment:

1. Парсим `comment_html` (lib: `node-html-parser` — минимальный, без
   деп-флота `parse5`).
2. Собираем все `<img src>`, `<a href>`, `<source src>`, `<video src>`.
3. **Strict filter** — оставляем только URL'ы, которые указывают на
   `MINIO_PUBLIC_ENDPOINT` **или** `MINIO_INTERNAL_ENDPOINT` host
   **и** содержат path-префикс `MINIO_BUCKET_PLANE`. Любой внешний
   URL игнорируется (SSRF-class защита, см. §7).
4. Для каждого допущенного asset:

   | Поле | Источник |
   |---|---|
   | `filename` | последний сегмент path или `<a>` text content |
   | `mime_type` | mime lookup по расширению или `image/*` для `<img>` |
   | `size` | `headObject` к MinIO (см. §5.4 — кэшируется) |
   | `uploaded_at` | `created_at` родительского комментария |
   | `uploaded_by` | автор комментария |
   | `comment_id` | id комментария |
   | `storage.object_key` | path после bucket-префикса |
   | `storage.bucket` | `MINIO_BUCKET_PLANE` |

Парсер — pure функция в `src/attachments/comment-assets.ts`, отдельно
покрыта unit-тестами на fixture'ах реального `comment_html` от Plane.

### 5.3. `mcp_artifact` — list MinIO bucket

MinIO SDK (`minio` npm), метод `listObjectsV2(bucket='mcp-artifacts',
prefix='issues/<issueId>/', recursive=true)`. Для каждого объекта:

- Парсим object_key по формату из `attach-file/handler.ts::makeObjectKey`
  (`issues/<id>/<ts>-<identity>-<filename>`) → `uploaded_at` из ts,
  `uploaded_by` из identity-сегмента, `filename` из остатка.
- `size` берётся из ответа `listObjectsV2`; `mime_type` — mime lookup по
  расширению.
- `comment_id` остаётся `undefined`. Текущий `attach_file complete` не
  сохраняет привязку к comment_id (только пишет комментарий со
  ссылкой); реконструировать обратную связь не пытаемся.

**Fallback на legacy объекты:** если object_key в bucket'е есть, но не
парсится по формату — `filename` = последний сегмент, `uploaded_at` =
`LastModified` из MinIO, `uploaded_by` = `undefined`. Не выкидываем — пусть
агент хотя бы знает, что файл существует.

### 5.4. Кэширование

- Каждый source-call → существующий TTL-кэш (`ttl=10s`, ключ =
  `list_attachments:<source>:<issueId>:<hash(filters)>`).
- `headObject` для inline-assets (требуется для `size`) → отдельный кэш
  `head:<bucket>:<key>` с тем же TTL.
- `read_attachment` НЕ использует кэш — presign всегда генерится свежим,
  чтобы `expires_in` соответствовал реальному TTL URL'а.

## 6. Presign

### 6.1. Клиент

`minio` npm package — S3-совместимый, поддерживает
`presignedGetObject(bucket, key, expirySec)`. Альтернатива
`aws4-fetch` отвергнута: для одного use-case (presigned GET) не
оправдывает ручную сборку запроса.

### 6.2. Креды и ENV

Новые ключи в `src/config.ts` (zod-валидация):

```
MINIO_ACCESS_KEY      // required, как PLANE_API_KEY
MINIO_SECRET_KEY      // required, secret; pino-redact
MINIO_BUCKET_PLANE    // default 'plane-uploads' (already in .env.example)
MINIO_USE_SSL         // default false для internal endpoint
MINIO_PUBLIC_ENDPOINT // optional; fallback MINIO_INTERNAL_ENDPOINT
```

В compose: те же `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, что уже
использует Plane (единый набор кредов). В `.env.example` — комментарий
«в проде разделить service-account с read-only policy на оба bucket'а;
v1 — общий root для упрощения».

### 6.3. Bucket-routing в `read_attachment`

| `source` | bucket |
|---|---|
| `plane_issue` | `MINIO_BUCKET_PLANE` |
| `plane_comment_inline` | `MINIO_BUCKET_PLANE` |
| `mcp_artifact` | `MINIO_BUCKET_MCP` |

После резолва — жёсткая check: если bucket ∉ `{MINIO_BUCKET_PLANE,
MINIO_BUCKET_MCP}` → `INVALID_INPUT`. Это страховка на случай, если в id
закралось что-то аномальное.

### 6.4. TTL, заголовки, endpoint

- `expires_in` = `PLANE_SIGNED_URL_EXPIRATION` (default 3600).
- `required_headers` для presigned GET — пусто.
- URL генерится для `MINIO_PUBLIC_ENDPOINT` (если задан), иначе для
  `MINIO_INTERNAL_ENDPOINT`. Оператор обязан выставить `PUBLIC` для
  агентов с хоста / снаружи docker-сети.
- В `/health` добавляем `minio_reachable` по аналогии с
  `plane_reachable`.

### 6.5. Existence validation

Перед возвратом URL делаем `statObject(bucket, key)`. На 404 →
`NOT_FOUND` (а не выдача битого URL). +1 round-trip к MinIO стоит того:
честный контракт «вернули URL — значит файл точно есть в этот момент».

## 7. Безопасность, ошибки, аудит

### 7.1. Ошибки

| Код | Когда |
|---|---|
| `INVALID_INPUT` | невалидный `attachment_id`, `since` не ISO8601, `limit > 200`, bucket вне whitelist |
| `NOT_FOUND` | задача не найдена; attachment_id валиден синтаксически, но объект удалён |
| `PLANE_UNAVAILABLE` | в `list_attachments` — только если упали ВСЕ три источника; иначе → partial |
| `STORAGE_UNAVAILABLE` | новый код — MinIO недоступен (`statObject` timeout / refused); для `read_attachment` фатально, для `list_attachments` partial |
| `RATE_LIMITED` | существующий token-bucket per-identity |

### 7.2. Project scoping

`resolveProject` уже отрезает кросс-проектный доступ — переиспользуется
без изменений в `list_attachments` и `read_attachment`. Агент не может
прочитать вложение задачи из не-разрешённого проекта.

### 7.3. SSRF-защита для inline-asset

При парсе `comment_html` принимаем asset URL **только** если:

1. URL парсится через `new URL(...)` (отклоняем кривые/относительные).
2. URL нормализуется (`pathname` без `..`-сегментов) — это режет
   path-traversal вроде `http://minio:9000/plane-uploads/../mcp-artifacts/secret`.
3. `host:port` совпадает с `MINIO_PUBLIC_ENDPOINT` или
   `MINIO_INTERNAL_ENDPOINT` (схема `http`/`https` тоже сверяется).
4. Первый сегмент `pathname` равен `MINIO_BUCKET_PLANE`.

Всё, что не прошло — игнорируется. Внешние URL
(`https://evil.example/foo.png`), URL на `mcp-artifacts` через комментарий
человека, path-traversal — отсекаются. Иначе агент через MCP может
дёрнуть произвольный ресурс под наш аудит (SSRF-class).

### 7.4. Presign-leak protection

- В `audit_log` пишется `bucket` + `object_key` + `expires_at`, не сам
  URL.
- В `pino`-логах signature редактируется: добавляется паттерн
  `?X-Amz-Signature=...` в существующий redact-список в `logger.ts`.
- Короткий TTL (1ч default) ограничивает окно утечки.

### 7.5. Identity и rate-limit

`read_attachment` помечается как write в terms of audit — идёт через
`withWriteGuard` (per-identity rate-limit, лог входа/выхода/duration).
`list_attachments` идёт как read — кэшируется, не учитывается в
write-rate-limit, но входит в global RPS.

## 8. Тестирование

### 8.1. Unit

- `parseAttachmentId` — все три формата + невалидный → throw.
- `comment-assets.ts` — fixture-based: реальный `comment_html` от Plane
  с разными формами `<img>`, `<a>`, абсолютные/относительные URL,
  внешние URL (must be filtered).
- Маппинг каждого источника в `Attachment` — отдельные хендлер-тесты
  по паттерну `tools/<name>/handler.test.ts`.
- Дедупликация id-генерации (один и тот же object_key → один и тот же
  `mca_*` id).
- Валидация input zod-схем — границы лимитов, формат since.

### 8.2. MinIO fakes

Добавляем `FakeMinioClient` в `test-fakes.ts` по аналогии с
`FakePlaneClient`. Inject через `ToolContext`. В тестах:
`objects: Map<key, {size, etag, lastModified, content?}>`;
`presignedGetObject(bucket, key, expiry) → 'fake://...?expires=N'`;
`statObject(bucket, key) → entry или throw NotFound`. Без реального
MinIO в unit-тестах.

### 8.3. Partial-failure scenarios

Один источник падает (Plane 500, MinIO connection refused, HTML парсер
throw) → результат содержит остальные два + `partial: true` + warning
в логах с указанием, какой source отвалился.

### 8.4. Integration (опционально)

Если в проекте уже есть `docker-compose.test.yml` со стеком Plane +
MinIO для других tools — переиспользуем для end-to-end теста. Если нет
— отдельная задача, не блокер v1.

## 9. Out of scope (фиксируем явно)

- **Write-side parity для `attach_file`** — v1-stub остаётся как есть.
  Парный «настоящий presigned PUT» через MinIO SDK — отдельная задача,
  с симметричным контрактом к `read_attachment`.
- **Inline-картинки в `description_html`** — только в `comment_html`
  для v1.
- **Persistent attachments index** в SQLite — TTL=10s кэша достаточно.
- **Content-dedup** по sha256 — отдельная задача.
- **Inline-байты в MCP-ответе** (base64 / image-content) — отвергнуто
  на этапе brainstorming (выбран pure URL-подход).
- **Разделённые service-account creds** для MinIO read/write —
  отдельная security-фаза вместе с Phase 7 TLS.

## 10. Краткий план изменений в файлах

> Это карта для последующего implementation plan'а, не сам план.

| Что | Где |
|---|---|
| ENV-ключи + zod-валидация | `mcp-kanban/src/config.ts` |
| Новый клиент MinIO (singleton) | `mcp-kanban/src/minio-client.ts` (new) |
| Метод `listIssueAttachments` в Plane-клиенте | `mcp-kanban/src/plane-client.ts` |
| Парсер inline-assets | `mcp-kanban/src/attachments/comment-assets.ts` (new) |
| Унифицированный record + id-схема | `mcp-kanban/src/attachments/types.ts` (new) |
| Discovery (3 source-функции + merge) | `mcp-kanban/src/attachments/discovery.ts` (new) |
| Tool `list_attachments` | `mcp-kanban/src/tools/list-attachments/{schema,handler,handler.test}.ts` (new) |
| Tool `read_attachment` | `mcp-kanban/src/tools/read-attachment/{schema,handler,handler.test}.ts` (new) |
| Расширение `get_issue` | `mcp-kanban/src/tools/get-issue/handler.ts` |
| Регистрация tools | `mcp-kanban/src/tools/registry.ts` |
| Fake MinIO для тестов | `mcp-kanban/src/tools/test-fakes.ts` |
| Pino-redact для presign signature | `mcp-kanban/src/logger.ts` |
| ENV-документация | `.env.example` |
| Compose-проброс кредов | `docker-compose.yml` (mcp-kanban service) |
| Обновить SPEC §6.2 | `docs/SPEC.md` |
| CHANGELOG `[Unreleased] → Added` | `docs/CHANGELOG.md` |

---

**Status:** awaiting user review before transition to writing-plans skill.
