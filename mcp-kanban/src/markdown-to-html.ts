// Минимальный конвертер пользовательского ввода (plain text / markdown-ish)
// в HTML, пригодный для записи в Plane'овское поле `description_html`
// (TipTap / ProseMirror).
//
// Plane v1.3.0 хранит тело задачи в `description_html`, парсит его
// TipTap'ом и сам генерирует `description_json` / `description_binary`.
// Поле `description` Plane тихо игнорирует — POST/PATCH 200 OK, но при
// GET тело пустое. Поэтому MCP должен слать именно `description_html`.
//
// Контракт:
//   - Разбиваем вход по пустой строке (`\n{2,}`) на параграфы.
//   - Каждый параграф — `<p>…</p>`; внутри одиночные `\n` превращаются
//     в `<br />` (мягкий перенос).
//   - HTML-эскейпим `& < > " '`, чтобы пользовательский ввод вида
//     `a<script>` не ломал страницу и не исполнялся в UI Plane.
//   - Пустой/whitespace-only вход → пустая строка (передаётся как
//     "очистить описание").

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Конвертит plain text / лёгкий markdown во входное HTML для TipTap.
 * Inline-разметка (`**bold**`, `# h1`, ссылки) НЕ парсится — TipTap её
 * не понимает и в любом случае показал бы литералы. Если в будущем
 * потребуется настоящий markdown — заводи отдельный конвертер
 * (например, `marked` → sanitize), сейчас сознательно простой контракт.
 */
export function toPlaneDescriptionHtml(input: string): string {
  if (input.length === 0) return '';
  // Нормализуем переводы строк (CRLF / CR → LF).
  const normalized = input.replace(/\r\n?/g, '\n');
  // Если после удаления любых whitespace-символов (включая пробелы и
  // табы) ничего не осталось — это «пустое описание», шлём пустую строку
  // ⇒ Plane очистит поле.
  if (normalized.trim().length === 0) return '';
  // Trim только хвостовых пустых строк, ведущие пробелы внутри строки
  // оставляем как есть (чтобы не ломать форматирование code-like блоков).
  const trimmed = normalized.replace(/^\n+|\n+$/g, '');

  const paragraphs = trimmed.split(/\n{2,}/);
  const html = paragraphs
    .map((para) => {
      const escaped = escapeHtml(para);
      // Одиночные переводы строки внутри параграфа — soft break.
      const withBreaks = escaped.replace(/\n/g, '<br />');
      return `<p>${withBreaks}</p>`;
    })
    .join('\n\n');
  return html;
}
