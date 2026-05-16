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
  it('returns empty string for empty / whitespace input', () => {
    expect(toPlaneDescriptionHtml('')).toBe('');
    expect(toPlaneDescriptionHtml('   \n\n   ')).toBe('');
  });

  it('wraps a single paragraph in <p>...</p>', () => {
    expect(toPlaneDescriptionHtml('Hello')).toBe('<p>Hello</p>');
  });

  it('splits double-newline into separate paragraphs', () => {
    expect(toPlaneDescriptionHtml('Hello\n\nWorld')).toBe('<p>Hello</p>\n\n<p>World</p>');
  });

  it('preserves soft breaks (single newline) as <br />', () => {
    expect(toPlaneDescriptionHtml('Line 1\nLine 2')).toBe('<p>Line 1<br />Line 2</p>');
  });

  it('HTML-escapes user input so <script> cannot execute in Plane UI', () => {
    expect(toPlaneDescriptionHtml('a<script>alert(1)</script>b')).toBe(
      '<p>a&lt;script&gt;alert(1)&lt;/script&gt;b</p>',
    );
  });

  it('escapes ampersands and quotes', () => {
    expect(toPlaneDescriptionHtml('Tom & Jerry "say" hi')).toBe(
      '<p>Tom &amp; Jerry &quot;say&quot; hi</p>',
    );
  });

  it('normalizes CRLF and CR to LF', () => {
    expect(toPlaneDescriptionHtml('a\r\nb')).toBe('<p>a<br />b</p>');
    expect(toPlaneDescriptionHtml('a\rb')).toBe('<p>a<br />b</p>');
  });

  it('collapses 3+ consecutive newlines into one paragraph break', () => {
    expect(toPlaneDescriptionHtml('a\n\n\n\nb')).toBe('<p>a</p>\n\n<p>b</p>');
  });

  it('trims only leading/trailing newlines, keeping internal structure', () => {
    expect(toPlaneDescriptionHtml('\n\nHello\n\nWorld\n\n')).toBe(
      '<p>Hello</p>\n\n<p>World</p>',
    );
  });
});
