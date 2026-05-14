import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  describe('typo handling for manifest.yml', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    function makeYaml(projectCount: number): string {
      const projects = Array.from({ length: projectCount }, (_, i) => {
        const n = i + 1;
        return `  - slug: p${n}\n    name: "Project ${n}"\n    identifier: P${n}\n    modules: []`;
      }).join('\n');
      return [
        'workspace:',
        '  slug: agents',
        '  name: "Agents"',
        'projects:',
        projects,
        'states:',
        '  - { name: Backlog, group: backlog, color: "#aaaaaa", order: 1 }',
        'labels:',
        '  - { name: agent-ready, color: "#00ff00" }',
        'identities:',
        '  - role: analyst-agent',
        '    email: analyst@example.com',
        '    first_name: Analyst',
        '    last_name: Agent',
        '    default_state: Backlog',
      ].join('\n');
    }

    it('warns and falls back to manifest.example.yaml when only manifest.yml exists', () => {
      // Reproduces the real user footgun from CHANGELOG: hostname `slonik`,
      // user created `manifest.yml` (no `a`) and wondered why bootstrap kept
      // recreating only the example's projects. Loader must scream loudly.
      const dir = mkdtempSync(join(tmpdir(), 'slonk-manifest-typo-'));
      writeFileSync(join(dir, 'manifest.yml'), makeYaml(5), 'utf8');
      writeFileSync(join(dir, 'manifest.example.yaml'), makeYaml(2), 'utf8');

      const m = loadManifest({ path: dir });

      expect(m.projects).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toMatch(/manifest\.yml/);
      expect(msg).toMatch(/manifest\.yaml/);
      expect(msg).toMatch(/manifest\.example\.yaml/);
    });

    it('also catches uppercase .YML extension', () => {
      // На case-insensitive FS (macOS APFS, NTFS) `Manifest.yaml` совпадает
      // с `manifest.yaml` и просто загружается без warn'а — это ок, файл
      // реально используется. Реальный footgun — другое расширение
      // (.yml вместо .yaml), которое не схлопывается case-folding'ом.
      const dir = mkdtempSync(join(tmpdir(), 'slonk-manifest-typo-'));
      writeFileSync(join(dir, 'manifest.YML'), makeYaml(3), 'utf8');
      writeFileSync(join(dir, 'manifest.example.yaml'), makeYaml(2), 'utf8');

      const m = loadManifest({ path: dir });

      expect(m.projects).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when manifest.yaml is present alongside example', () => {
      const dir = mkdtempSync(join(tmpdir(), 'slonk-manifest-typo-'));
      writeFileSync(join(dir, 'manifest.yaml'), makeYaml(5), 'utf8');
      writeFileSync(join(dir, 'manifest.example.yaml'), makeYaml(2), 'utf8');

      const m = loadManifest({ path: dir });

      expect(m.projects).toHaveLength(5);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('YAML parse errors', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'slonk-manifest-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('rewraps YAMLParseError into a human-readable message with file + line hint', () => {
      // Битый YAML: пользователь забыл два пробела перед `- slug:` под `projects:`,
      // получает YAMLParseError из библиотеки yaml. Loader должен перехватить
      // его и отдать понятное сообщение с указанием файла и строки.
      const broken = [
        'workspace:',
        '  slug: agents',
        '  name: Agents',
        'projects:',
        '- slug: bezpravilnet',
        '  name: Bezpravilnet',
        '  identifier: BZP',
        '  modules: []',
        '\tbad: tab-indent-here',
      ].join('\n');
      const path = join(dir, 'manifest.yaml');
      writeFileSync(path, broken, 'utf8');

      expect(() => loadManifest({ path })).toThrow(/Invalid YAML in bootstrap manifest/);
      expect(() => loadManifest({ path })).toThrow(/line \d+, col \d+/);
      // не должно протекать имя класса/стек-трейс из node_modules
      try {
        loadManifest({ path });
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toMatch(/node_modules/);
        expect(msg).not.toMatch(/YAMLParseError/);
        expect(msg).toContain(path);
      }
    });

    it('passes through schema (zod) errors unchanged — only YAMLParseError is wrapped', () => {
      // Валидный YAML, но не проходит ManifestSchema — должны видеть прежнее
      // сообщение `Invalid bootstrap manifest`, а не YAML-обёртку.
      const valid = 'workspace:\n  slug: x\n';
      const path = join(dir, 'manifest.yaml');
      writeFileSync(path, valid, 'utf8');
      expect(() => loadManifest({ path })).toThrow(/Invalid bootstrap manifest/);
    });
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
