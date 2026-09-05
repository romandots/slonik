// Общие дефолты и валидация для OAuth/multitenant. Вынесены сюда, чтобы
// server.ts (рантайм) и bootstrap CLI (add-tenant / bootstrap) ссылались на
// один источник правды и не расходились (SLONK-18).

/** Контейнерный дефолт пути к OAuth-стору (том mcp_data). */
export const OAUTH_STORE_DEFAULT_PATH = '/mcp_data/oauth.sqlite';

/**
 * Дефолт per-tenant cap OAuth-клиентов, когда конфиг недоступен (host-режим
 * CLI без ENV). Совпадает с `MCP_OAUTH_MAX_CLIENTS` default в config.ts.
 */
export const DEFAULT_OAUTH_MAX_CLIENTS = 50;

/**
 * Сколько клиент защищён от вытеснения после регистрации.
 *
 * Между DCR и обменом кода на токен проходит время: человек читает форму
 * логина, вводит workspace и пароль. Всё это окно у клиента нет ни одного
 * токена, то есть по формальному признаку он «мёртвый». Вытеснить его
 * значит сломать авторизацию на полпути, поэтому свежие клиенты
 * неприкосновенны независимо от давления на cap.
 */
export const CLIENT_EVICTION_GRACE_MS = 60 * 60 * 1000;

/**
 * Допустимый Plane workspace-slug: lowercase буквы/цифры/дефисы, без ведущего
 * и завершающего дефиса (Plane такие slug'и отвергает/нормализует на своей
 * стороне). Используется и для валидации ввода, и как защита от подстановки
 * `../`-сегментов в URL (path traversal / SSRF к Plane API).
 */
export const WORKSPACE_SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** true, если строка — валидный workspace-slug (см. WORKSPACE_SLUG_RE). */
export function isValidWorkspaceSlug(slug: string): boolean {
  return WORKSPACE_SLUG_RE.test(slug);
}
