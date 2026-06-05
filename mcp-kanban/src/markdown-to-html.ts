// Конвертер markdown → HTML для поля `description_html` Plane (TipTap).
//
// Plane v1.3.0 хранит тело задачи в `description_html`, парсит его
// TipTap'ом и генерирует `description_json` / `description_binary`.
// Поле `description` Plane тихо игнорирует — POST/PATCH 200 OK, но при
// GET тело пустое. Поэтому MCP должен слать именно `description_html`.
//
// Конвертация: marked (CommonMark-совместимый парсер) → sanitizeHtml.
// Поддерживаются все стандартные блоки: заголовки, параграфы, списки,
// жирный/курсив, встроенный код, блоки кода, цитаты, ссылки.
// Небезопасные теги (script, style, iframe …) вырезаются.

import { parse as markdownParse } from 'marked';
import { sanitizeHtml } from './sanitize-html.js';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Экранирует пять HTML-значимых символов. Используется в тестах и утилитах. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Конвертит markdown-строку в HTML, пригодный для `description_html` Plane.
 * Пустой / whitespace-only вход → пустая строка («очистить описание»).
 */
export function toPlaneDescriptionHtml(input: string): string {
  if (input.trim().length === 0) return '';
  const raw = markdownParse(input) as string;
  return sanitizeHtml(raw).trim();
}
