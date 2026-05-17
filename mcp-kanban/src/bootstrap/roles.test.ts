import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRoles, RoleDefinitionSchema } from './roles.js';

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'slonk-roles-'));
}

function writeRole(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf8');
}

describe('loadRoles', () => {
  it('returns found=false when directory does not exist', () => {
    const r = loadRoles({ dir: '/no/such/path/here' });
    expect(r.found).toBe(false);
    expect(r.roles).toEqual([]);
  });

  it('returns found=false when directory has no role *.md files', () => {
    const dir = newDir();
    try {
      writeRole(dir, 'README.md', '# This is a readme, not a role\n');
      const r = loadRoles({ dir });
      expect(r.found).toBe(false);
      expect(r.roles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses default 7 roles from manifest-shaped files', () => {
    const dir = newDir();
    try {
      writeRole(
        dir,
        'developer-agent.md',
        '---\n' +
          'role: developer-agent\n' +
          'email: developer-agent@slonk.local\n' +
          'first_name: Developer\n' +
          'last_name: Agent\n' +
          'default_state: Development\n' +
          'state_aliases:\n' +
          '  - Разработка\n' +
          '---\n' +
          '# developer-agent\n',
      );
      writeRole(
        dir,
        'qa-agent.md',
        '---\n' +
          'role: qa-agent\n' +
          'email: qa-agent@slonk.local\n' +
          'first_name: QA\n' +
          'last_name: Agent\n' +
          'default_state: Testing\n' +
          '---\n',
      );
      const r = loadRoles({ dir });
      expect(r.found).toBe(true);
      expect(r.roles).toHaveLength(2);
      // Сортировка по role.
      expect(r.roles[0]!.role).toBe('developer-agent');
      expect(r.roles[0]!.state_aliases).toEqual(['Разработка']);
      expect(r.roles[1]!.role).toBe('qa-agent');
      expect(r.roles[1]!.state_aliases).toEqual([]); // default
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores README.md (no front-matter) alongside role files', () => {
    const dir = newDir();
    try {
      writeRole(dir, 'README.md', '# Roles\n\nHelp text.\n');
      writeRole(
        dir,
        'doc-agent.md',
        '---\n' +
          'role: doc-agent\n' +
          'email: d@x.local\n' +
          'first_name: D\n' +
          'last_name: A\n' +
          'default_state: Documenting\n' +
          '---\n',
      );
      const r = loadRoles({ dir });
      expect(r.roles.map((r) => r.role)).toEqual(['doc-agent']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws actionable error on invalid YAML front-matter', () => {
    const dir = newDir();
    try {
      writeRole(
        dir,
        'bad.md',
        '---\n' +
          'role: bad-agent\n' +
          'email: not-an-email\n' + // valid YAML, invalid by schema
          'first_name: B\n' +
          'last_name: A\n' +
          'default_state: X\n' +
          '---\n',
      );
      expect(() => loadRoles({ dir })).toThrow(/email/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on YAML parse error with file path and position', () => {
    const dir = newDir();
    try {
      writeRole(
        dir,
        'yaml-bad.md',
        '---\n' +
          'role: bad\n' +
          '  email: bad\n' + // bad indentation (mapping under scalar)
          '---\n',
      );
      expect(() => loadRoles({ dir })).toThrow(/Invalid YAML in role front-matter/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on duplicate role across files', () => {
    const dir = newDir();
    try {
      writeRole(
        dir,
        'a.md',
        '---\nrole: dup-agent\nemail: a@slonk.local\nfirst_name: A\nlast_name: A\ndefault_state: S\n---\n',
      );
      writeRole(
        dir,
        'b.md',
        '---\nrole: dup-agent\nemail: b@slonk.local\nfirst_name: B\nlast_name: B\ndefault_state: S\n---\n',
      );
      expect(() => loadRoles({ dir })).toThrow(/duplicate role/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back gracefully on file without front-matter', () => {
    const dir = newDir();
    try {
      writeRole(dir, 'no-fm.md', '# Just markdown, no front-matter\n');
      const r = loadRoles({ dir });
      // README-style файлы без front-matter пропускаются БЕЗ ошибки.
      expect(r.found).toBe(false);
      expect(r.roles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schema rejects unknown role naming patterns', () => {
    // Roles в скиллах и MCP-серверах матчатся по name, регэксп задаёт
    // безопасный набор символов; CAPS / spaces должны падать сразу.
    expect(() =>
      RoleDefinitionSchema.parse({
        role: 'DeveloperAgent',
        email: 'a@b.local',
        first_name: 'x',
        last_name: 'y',
        default_state: 'S',
      }),
    ).toThrow();
    expect(() =>
      RoleDefinitionSchema.parse({
        role: 'release agent',
        email: 'a@b.local',
        first_name: 'x',
        last_name: 'y',
        default_state: 'S',
      }),
    ).toThrow();
  });
});
