// Whitelist-based HTML sanitizer for content sent to Plane's TipTap editor.
// Used by both description (markdown output) and comment formatters.
//
// Allowed block/inline tags cover the full ProseMirror node set that Plane
// renders. Attributes are stripped except `href`/`title` on <a> and `class`
// on <code> (language hint from fenced code blocks). href must be http(s)
// or mailto — javascript: and data: are blocked.

const ALLOWED_TAGS = new Set([
  'p', 'br',
  'strong', 'b', 'em', 'i', 'u', 's',
  'code', 'pre',
  'ul', 'ol', 'li',
  'a',
  'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr',
]);

const SAFE_URL = /^(https?:|mailto:)/i;

export function sanitizeHtml(input: string): string {
  // 1) Strip dangerous block-level elements (incl. their content).
  const stripped = input.replace(
    /<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  // 2) Walk every remaining tag: keep whitelist, strip attributes, validate href.
  return stripped.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (_m, rawTag: string, rest: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    const isClose = _m.startsWith('</');
    if (isClose) return `</${tag}>`;
    if (tag === 'a') {
      const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(rest);
      const url = href?.[2] ?? href?.[3];
      if (url !== undefined && SAFE_URL.test(url.trim())) {
        return `<a href="${url.replace(/"/g, '&quot;')}" rel="noopener noreferrer">`;
      }
      return '<a>';
    }
    if (tag === 'code') {
      // Preserve language class emitted by marked (e.g. class="language-ts").
      const cls = /\bclass\s*=\s*"([^"]*)"/i.exec(rest);
      if (cls?.[1] !== undefined) return `<code class="${cls[1].replace(/"/g, '&quot;')}">`;
    }
    return `<${tag}>`;
  });
}
