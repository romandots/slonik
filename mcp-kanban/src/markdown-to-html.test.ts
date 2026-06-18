import { describe, expect, it } from 'vitest';
import { escapeHtml, toPlaneDescriptionHtml } from './markdown-to-html.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe(`&amp; &lt; &gt; &quot; &#39;`);
  });

  it('leaves benign characters untouched', () => {
    expect(escapeHtml('Hello, world 123 — текст')).toBe('Hello, world 123 — текст');
  });

  it('handles empty input', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('toPlaneDescriptionHtml', () => {
  it('returns empty string for empty / whitespace-only input', () => {
    expect(toPlaneDescriptionHtml('')).toBe('');
    expect(toPlaneDescriptionHtml('   \n\n   ')).toBe('');
  });

  it('wraps plain text in a paragraph', () => {
    expect(toPlaneDescriptionHtml('Hello')).toBe('<p>Hello</p>');
  });

  it('splits double-newline into separate paragraphs', () => {
    const result = toPlaneDescriptionHtml('Hello\n\nWorld');
    expect(result).toContain('<p>Hello</p>');
    expect(result).toContain('<p>World</p>');
  });

  // Inline markdown formatting
  it('converts **bold** to <strong>', () => {
    expect(toPlaneDescriptionHtml('**bold**')).toBe('<p><strong>bold</strong></p>');
  });

  it('converts *italic* to <em>', () => {
    expect(toPlaneDescriptionHtml('*italic*')).toBe('<p><em>italic</em></p>');
  });

  it('converts `inline code` to <code>', () => {
    expect(toPlaneDescriptionHtml('`code`')).toBe('<p><code>code</code></p>');
  });

  // Block markdown
  it('converts ATX headings', () => {
    expect(toPlaneDescriptionHtml('## Заголовок')).toBe('<h2>Заголовок</h2>');
  });

  it('converts unordered list', () => {
    const input = '- item 1\n- item 2';
    const result = toPlaneDescriptionHtml(input);
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>item 1</li>');
    expect(result).toContain('<li>item 2</li>');
    expect(result).toContain('</ul>');
  });

  it('converts ordered list', () => {
    const input = '1. first\n2. second';
    const result = toPlaneDescriptionHtml(input);
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>first</li>');
    expect(result).toContain('</ol>');
  });

  it('converts fenced code block to <pre><code>', () => {
    const input = '```\nconsole.log("hello")\n```';
    const result = toPlaneDescriptionHtml(input);
    expect(result).toContain('<pre>');
    expect(result).toContain('<code>');
    expect(result).toContain('console.log');
  });

  it('converts blockquote', () => {
    const result = toPlaneDescriptionHtml('> cited text');
    expect(result).toContain('<blockquote>');
    expect(result).toContain('cited text');
  });

  it('converts markdown link to <a> with rel attribute', () => {
    const result = toPlaneDescriptionHtml('[Click](https://example.com)');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('rel="noopener noreferrer"');
    expect(result).toContain('Click');
  });

  // Security
  it('strips <script> tags from raw HTML in input', () => {
    const result = toPlaneDescriptionHtml('<script>alert(1)</script>safe');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert(1)');
    expect(result).toContain('safe');
  });

  it('blocks javascript: links', () => {
    const result = toPlaneDescriptionHtml('[xss](javascript:alert(1))');
    expect(result).not.toContain('javascript:');
  });

  // Mixed content
  it('handles a realistic multi-block description', () => {
    const input = [
      '## Описание задачи',
      '',
      'Нужно **реализовать** конвертацию markdown → HTML.',
      '',
      '### Критерии приёмки',
      '',
      '- `toPlaneDescriptionHtml` парсит markdown',
      '- Тесты зелёные',
    ].join('\n');
    const result = toPlaneDescriptionHtml(input);
    expect(result).toContain('<h2>Описание задачи</h2>');
    expect(result).toContain('<strong>реализовать</strong>');
    expect(result).toContain('<h3>Критерии приёмки</h3>');
    expect(result).toContain('<li>');
    expect(result).toContain('<code>toPlaneDescriptionHtml</code>');
  });
});
