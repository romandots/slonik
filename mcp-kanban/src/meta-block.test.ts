import { describe, expect, it } from 'vitest';
import {
  parseDescription,
  serializeDescription,
  upsertGitRef,
  removeGitRef,
  preserveCorruptDescription,
  MetaBlockMarker,
} from './meta-block.js';
import { simulateTipTap } from './tools/test-fakes.js';

const sample = `
Implement auth flow.

Some body text.

${MetaBlockMarker}
repos:
  - url: https://github.com/acme/backend
    branch: feature/SLONK-123-auth-flow
    pr: https://github.com/acme/backend/pull/456
    commits:
      - 4f1a2b3
      - 9c8d7e6f
`;

describe('parseDescription', () => {
  it('returns empty meta for empty input', () => {
    const r = parseDescription('');
    expect(r.body).toBe('');
    expect(r.meta.repos).toEqual([]);
    expect(r.corrupt).toBe(false);
  });

  it('treats description without marker as pure body', () => {
    const r = parseDescription('Just a description, no meta.');
    expect(r.body).toBe('Just a description, no meta.');
    expect(r.meta.repos).toEqual([]);
  });

  it('extracts body + repos', () => {
    const r = parseDescription(sample);
    expect(r.body).toContain('Some body text');
    expect(r.body).not.toContain('slonk:meta');
    expect(r.meta.repos).toHaveLength(1);
    expect(r.meta.repos[0]?.commits).toEqual(['4f1a2b3', '9c8d7e6f']);
    expect(r.corrupt).toBe(false);
  });

  it('flags corrupt when commit sha is bad', () => {
    const broken = `
body
${MetaBlockMarker}
repos:
  - url: https://example.com/x
    commits: [ "NOT_A_HEX_SHA" ]
`;
    const r = parseDescription(broken);
    expect(r.corrupt).toBe(true);
    expect(r.error).toMatch(/commit/i);
    expect(r.meta.repos).toEqual([]);
  });

  it('flags corrupt when YAML is malformed', () => {
    const broken = `
body
${MetaBlockMarker}
repos: : : not yaml
`;
    const r = parseDescription(broken);
    expect(r.corrupt).toBe(true);
  });
});

describe('serializeDescription', () => {
  it('round-trips body + meta', () => {
    const parsed = parseDescription(sample);
    const round = serializeDescription(parsed.body, parsed.meta);
    const reparsed = parseDescription(round);
    expect(reparsed.body).toBe(parsed.body);
    expect(reparsed.meta).toEqual(parsed.meta);
  });

  it('omits the block when meta is empty', () => {
    const out = serializeDescription('hello', { repos: [] });
    expect(out).toBe('hello');
  });
});

describe('upsertGitRef / removeGitRef', () => {
  it('upsert is idempotent by url+commit', () => {
    let meta = { repos: [] as never[] };
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      branch: 'feature/x',
      commits: ['abcdef1'],
    });
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      branch: 'feature/x',
      commits: ['abcdef1'],
    });
    expect(meta.repos).toHaveLength(1);
    expect(meta.repos[0]?.commits).toEqual(['abcdef1']);
  });

  it('upsert merges commits and adds pr_url', () => {
    let meta = { repos: [] as never[] };
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      branch: 'feature/x',
      commits: ['aaaaaaa'],
    });
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      pr: 'https://github.com/acme/backend/pull/1',
      commits: ['bbbbbbb'],
    });
    expect(meta.repos).toHaveLength(1);
    expect(meta.repos[0]?.commits).toEqual(['aaaaaaa', 'bbbbbbb']);
    expect(meta.repos[0]?.pr).toBe('https://github.com/acme/backend/pull/1');
    expect(meta.repos[0]?.branch).toBe('feature/x');
  });

  it('remove drops by url+commit', () => {
    let meta = { repos: [] as never[] };
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      commits: ['aaaaaaa', 'bbbbbbb'],
      branch: 'b',
    });
    meta = removeGitRef(meta, { url: 'https://github.com/acme/backend', commit: 'aaaaaaa' });
    expect(meta.repos[0]?.commits).toEqual(['bbbbbbb']);
  });

  it('remove without commit drops the whole entry', () => {
    let meta = { repos: [] as never[] };
    meta = upsertGitRef(meta, {
      url: 'https://github.com/acme/backend',
      commits: ['aaaaaaa'],
    });
    meta = removeGitRef(meta, { url: 'https://github.com/acme/backend' });
    expect(meta.repos).toHaveLength(0);
  });
});

describe('preserveCorruptDescription', () => {
  const corrupt = `Body content.

${MetaBlockMarker}
repos:
  - url: https://example.com/x
    commits: [ "NOT_A_HEX_SHA" ]
`;

  it('extracts body before the marker and wraps the corrupt yaml in a fenced quote', () => {
    const out = preserveCorruptDescription(corrupt);
    expect(out.recovered).toBe(true);
    expect(out.body).toBe('Body content.');
    expect(out.quoted).toContain('slonk:corrupt-meta-preserved');
    expect(out.quoted).toContain('NOT_A_HEX_SHA');
    expect(out.quoted).toMatch(/^```yaml/m);
  });

  it('returns recovered:false when there is no marker to recover from', () => {
    const out = preserveCorruptDescription('Just plain body.');
    expect(out.recovered).toBe(false);
    expect(out.body).toBe('Just plain body.');
    expect(out.quoted).toBe('');
  });

  it('chooses a longer fence if the corrupt content itself contains triple-backticks', () => {
    const tricky = `body
${MetaBlockMarker}
\`\`\`
not-yaml-but-pretending-to-be
\`\`\`
`;
    const out = preserveCorruptDescription(tricky);
    expect(out.recovered).toBe(true);
    // Внешний забор должен быть длиннее 3 backticks, иначе вложенные сломают markdown.
    expect(out.quoted).toMatch(/^`{4,}yaml/m);
  });
});

// Регрессии под SLONK-7 bounce-back: маркер meta-блока должен переживать
// TipTap-санитайзер Plane v1.3.0 (он вырезает HTML-комментарии и
// оборачивает описание во внешний <div>...</div>). simulateTipTap в
// test-fakes.ts эмулирует наблюдаемое поведение прода.
describe('parseDescription survives Plane TipTap round-trip (SLONK-7)', () => {
  it('extracts meta after TipTap wraps body in <div> and strips legacy HTML-comment marker', () => {
    // Если у нас уже был записан НОВЫЙ маркер (`--- slonk:meta v1 ---`),
    // прохождение через TipTap НЕ должно ломать meta — это и есть фикс SLONK-7.
    const body = '<p>Body paragraph.</p>';
    const meta = upsertGitRef(
      { repos: [] },
      { url: 'https://github.com/example/repo', branch: 'feature/x', commits: ['abcdef0'] },
    );
    const serialized = serializeDescription(body, meta);
    const afterTipTap = simulateTipTap(serialized);
    // sanity: внешний <div> на месте, маркер не вырезан.
    expect(afterTipTap).toMatch(/^<div>/);
    expect(afterTipTap).toContain(MetaBlockMarker);
    const reparsed = parseDescription(afterTipTap);
    expect(reparsed.corrupt).toBe(false);
    expect(reparsed.body).toContain('Body paragraph');
    expect(reparsed.meta.repos).toHaveLength(1);
    expect(reparsed.meta.repos[0]?.commits).toEqual(['abcdef0']);
    expect(reparsed.meta.repos[0]?.branch).toBe('feature/x');
  });

  it('extracts meta when body is empty and marker is pressed against <div>', () => {
    // Edge-case: тело пустое, маркер прижат к открывающему <div>.
    // HEADER_RE должен сматчиться после unwrapPlaneDiv (иначе якорь
    // `^` / `\n` перед маркером не сработает).
    const meta = upsertGitRef(
      { repos: [] },
      { url: 'https://github.com/example/repo', commits: ['1234567'] },
    );
    const serialized = serializeDescription('', meta);
    const afterTipTap = simulateTipTap(serialized);
    expect(afterTipTap).toContain(MetaBlockMarker);
    const reparsed = parseDescription(afterTipTap);
    expect(reparsed.corrupt).toBe(false);
    expect(reparsed.body).toBe('');
    expect(reparsed.meta.repos).toHaveLength(1);
    expect(reparsed.meta.repos[0]?.commits).toEqual(['1234567']);
  });

  it('upsert is idempotent across TipTap round-trips (the original SLONK-7 QA bounce reason)', () => {
    // Сценарий, который провалился в QA-smoke первого фикса SLONK-7:
    // два последовательных link_git_ref для одного и того же repo
    // должны дать meta.repos.length === 1 c двумя commit'ами. На
    // legacy-маркере второй link читал description после TipTap
    // (маркер вырезан) → meta.repos: [] → второй link создавал НОВУЮ
    // запись вместо мерджа → idempotency сломана.
    let serialized = serializeDescription('', { repos: [] });
    let html = simulateTipTap(serialized);

    // First link
    let parsed = parseDescription(html);
    let nextMeta = upsertGitRef(parsed.meta, {
      url: 'https://github.com/example/repo',
      branch: 'feature/SLONK-7-smoke',
      commits: ['abcdef0'],
    });
    serialized = serializeDescription(parsed.body, nextMeta);
    html = simulateTipTap(serialized);

    // Second link, same repo, new commit
    parsed = parseDescription(html);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.meta.repos).toHaveLength(1); // <-- была регрессия: 0
    nextMeta = upsertGitRef(parsed.meta, {
      url: 'https://github.com/example/repo',
      commits: ['1234567'],
    });
    serialized = serializeDescription(parsed.body, nextMeta);
    html = simulateTipTap(serialized);

    // Third read: должно быть 1 repo с двумя коммитами
    parsed = parseDescription(html);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.meta.repos).toHaveLength(1);
    expect(parsed.meta.repos[0]?.commits).toEqual(['abcdef0', '1234567']);
    expect(parsed.meta.repos[0]?.branch).toBe('feature/SLONK-7-smoke');
  });

  it('migrates legacy HTML-comment marker on read (one-time, before TipTap strips it)', () => {
    // На задачах, созданных до фикса (но ещё не прошедших через TipTap),
    // маркер был `<!-- slonk:meta v1 -->`. Read-путь должен распознать
    // legacy-форму ради миграции. Write-путь всегда пишет новый маркер.
    const legacy = `Body text.\n\n---\n<!-- slonk:meta v1 -->\nrepos:\n  - url: https://github.com/legacy/repo\n    commits:\n      - abcdef0\n`;
    const parsed = parseDescription(legacy);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.meta.repos).toHaveLength(1);
    expect(parsed.meta.repos[0]?.url).toBe('https://github.com/legacy/repo');

    // А при re-serialization мы пишем уже новый маркер.
    const round = serializeDescription(parsed.body, parsed.meta);
    expect(round).toContain(MetaBlockMarker);
    expect(round).not.toContain('<!--');
  });

  it('legacy HTML-comment marker is unrecoverable after TipTap strips it (expected & documented)', () => {
    // Документируем: если legacy-задача уже один раз прошла через TipTap
    // (маркер вырезан) — meta потеряна и восстановить её мы не можем,
    // потому что в description остаётся только текстовый YAML без якоря.
    // Это известный one-way отказ legacy-формата; новый текстовый
    // sentinel не имеет этого свойства.
    const legacy = `Body text.\n\n---\n<!-- slonk:meta v1 -->\nrepos:\n  - url: https://github.com/legacy/repo\n`;
    const afterTipTap = simulateTipTap(legacy);
    expect(afterTipTap).not.toContain('<!--');
    const parsed = parseDescription(afterTipTap);
    // Маркер потерян → meta пуст; YAML остаётся в body как plain text.
    expect(parsed.meta.repos).toHaveLength(0);
    expect(parsed.body).toContain('repos:');
  });
});
