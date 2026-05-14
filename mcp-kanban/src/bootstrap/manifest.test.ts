import { describe, expect, it } from 'vitest';
import { loadManifest, ManifestSchema } from './manifest.js';

describe('loadManifest', () => {
  it('loads and validates the shipped bootstrap manifest', () => {
    // loadManifest() сначала ищет локальный manifest.yaml (gitignored,
    // конфиг конкретной установки), при его отсутствии падает на
    // committed-шаблон manifest.example.yaml. Тест должен проходить в
    // обоих сценариях — поэтому проверяем инварианты, а не точный список
    // проектов конкретной установки.
    const m = loadManifest();
    expect(m.workspace.slug).toBe('agents');
    expect(m.projects.length).toBeGreaterThanOrEqual(1);
    for (const p of m.projects) {
      expect(p.identifier).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    // 12 states (Backlog + 9 рабочих + Blocked + Done + Cancelled),
    // 14 labels, 7 identities (6 ролевых агентов + merger) — фиксированный
    // контракт SPEC §5 / CLAUDE.md.
    expect(m.states).toHaveLength(12);
    expect(m.labels).toHaveLength(14);
    expect(m.identities).toHaveLength(7);
  });

  it('rejects manifest with bad state group', () => {
    const bad = {
      workspace: { slug: 'a', name: 'A' },
      projects: [{ slug: 'p', name: 'P', identifier: 'P', modules: [] }],
      states: [{ name: 'X', group: 'never_heard_of_it', color: '#ffffff', order: 1 }],
      labels: [{ name: 'l', color: '#ffffff' }],
      identities: [
        {
          role: 'r',
          email: 'r@example.com',
          first_name: 'R',
          last_name: 'X',
          default_state: 'X',
        },
      ],
    };
    expect(() => ManifestSchema.parse(bad)).toThrow();
  });

  it('rejects manifest with special chars in project name (Plane v1.3.0 400 footgun)', () => {
    // Plane v1.3.0 валидирует project.name regex'ом и режет 400 на точках,
    // em-dash и подобном. Локальная zod-валидация ловит то же самое до похода
    // в Plane — иначе один кривой `name` блокирует все остальные проекты.
    const bad = {
      workspace: { slug: 'a', name: 'A' },
      projects: [{ slug: 'p', name: 'foo.bar', identifier: 'P', modules: [] }],
      states: [{ name: 'X', group: 'backlog', color: '#ffffff', order: 1 }],
      labels: [{ name: 'l', color: '#ffffff' }],
      identities: [
        {
          role: 'r',
          email: 'r@example.com',
          first_name: 'R',
          last_name: 'X',
          default_state: 'X',
        },
      ],
    };
    expect(() => ManifestSchema.parse(bad)).toThrow(/Plane project name must match/);

    // и em-dash в исходном багрепорте — тоже должен резаться
    const badDash = { ...bad, projects: [{ ...bad.projects[0], name: 'Foo — Bar' }] };
    expect(() => ManifestSchema.parse(badDash)).toThrow(/Plane project name must match/);

    // но дефис, подчёркивание, цифры и пробелы — ок (это валидно для Plane)
    const ok = { ...bad, projects: [{ ...bad.projects[0], name: 'Foo Bar_2 - baz' }] };
    expect(() => ManifestSchema.parse(ok)).not.toThrow(/Plane project name must match/);
  });

  it('rejects manifest with non-hex color', () => {
    const bad = {
      workspace: { slug: 'a', name: 'A' },
      projects: [{ slug: 'p', name: 'P', identifier: 'P', modules: [] }],
      states: [{ name: 'X', group: 'backlog', color: 'red', order: 1 }],
      labels: [{ name: 'l', color: '#ffffff' }],
      identities: [
        {
          role: 'r',
          email: 'r@example.com',
          first_name: 'R',
          last_name: 'X',
          default_state: 'X',
        },
      ],
    };
    expect(() => ManifestSchema.parse(bad)).toThrow(/expected #rrggbb/);
  });
});
