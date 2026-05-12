import { describe, expect, it } from 'vitest';
import { loadManifest, ManifestSchema } from './manifest.js';

describe('loadManifest', () => {
  it('loads and validates the shipped bootstrap/manifest.yaml', () => {
    const m = loadManifest();
    expect(m.workspace.slug).toBe('agents');
    // Manifest должен иметь хотя бы один проект с валидным uppercase
    // identifier. Конкретный список проектов и их identifier'ы — конфиг
    // конкретной установки, тест на это не должен ломаться.
    expect(m.projects.length).toBeGreaterThanOrEqual(1);
    for (const p of m.projects) {
      expect(p.identifier).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    // 11 states, 14 labels, 6 identities — фиксированный контракт SPEC §5
    expect(m.states).toHaveLength(11);
    expect(m.labels).toHaveLength(14);
    expect(m.identities).toHaveLength(6);
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
