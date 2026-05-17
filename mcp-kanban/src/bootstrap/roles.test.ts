import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRoles, RoleDefinitionSchema } from './roles.js';

const VALID_ROLE_FRONT_MATTER =
  '---\n' +
  'role: doc-agent\n' +
  'email: doc-agent@slonk.local\n' +
  'first_name: Doc\n' +
  'last_name: Agent\n' +
  'default_state: Documenting\n' +
  '---\n';

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'slonk-roles-'));
}

function writeRole(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf8');
}

/**
 * Минимальная заглушка pino-логгера: запоминает только bindings из `.warn()`,
 * остальные методы — no-op. Используется в SLONK-10-тестах, чтобы проверить,
 * что loader не утечёт в лог содержимое / путь цели симлинка.
 */
function makeStubLogger(
  onWarn: (bindings: Record<string, unknown>) => void,
): import('../logger.js').Logger {
  const noop = (): void => {};
  const stub = {
    warn: (bindings: Record<string, unknown>): void => {
      onWarn(bindings);
    },
    info: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    level: 'warn',
    child: () => stub,
  } as unknown as import('../logger.js').Logger;
  return stub;
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

  // SLONK-10: симлинки в `roles/` не должны следоваться — иначе атакующий с
  // write-доступом к директории может подсунуть `evil.md -> /etc/passwd` и
  // выгрузить первые байты файла в stderr через YAML/zod-падение.
  // Тесты пропускаем на Windows, потому что `symlinkSync` требует прав
  // администратора и на нашем Linux/macOS CI это не релевантно.
  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix(
    'SLONK-10: skips symlink pointing to an external file without reading the target',
    () => {
      const dir = newDir();
      const externalDir = newDir();
      const externalFile = join(externalDir, 'secret.txt');
      try {
        // Цель симлинка — файл вне `dir`, начинающийся с `---` (чтобы при
        // случайном чтении он попал в `parseYaml` и выдал бы read-сигнал в
        // throw-сообщении). Loader не должен его коснуться вообще.
        writeFileSync(externalFile, '---\nsecret: do-not-read\n---\n', 'utf8');
        symlinkSync(externalFile, join(dir, 'evil.md'));

        const warnings: Array<{ name?: string; kind?: string }> = [];
        const logger = makeStubLogger((bindings) => warnings.push(bindings));

        const r = loadRoles({ dir, logger });

        expect(r.found).toBe(false);
        expect(r.roles).toEqual([]);
        // Одна warn-запись на пропущенный symlink, без содержимого / target'а.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ name: 'evil.md', kind: 'symlink' });
        const serialized = JSON.stringify(warnings[0]);
        expect(serialized).not.toContain('secret');
        expect(serialized).not.toContain(externalFile);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(externalDir, { recursive: true, force: true });
      }
    },
  );

  itPosix(
    'SLONK-10: skips symlink pointing to a valid role file in a sibling directory',
    () => {
      const dir = newDir();
      const externalDir = newDir();
      const externalRole = join(externalDir, 'doc-agent.md');
      try {
        // Даже если target — настоящая корректная роль, loader не должен
        // тащить её через ссылку: иначе через `..` можно подложить
        // identity, которой нет в директории `MCP_ROLES_DIR`.
        writeFileSync(externalRole, VALID_ROLE_FRONT_MATTER, 'utf8');
        symlinkSync(externalRole, join(dir, 'dev.md'));

        const r = loadRoles({ dir });

        expect(r.found).toBe(false);
        expect(r.roles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(externalDir, { recursive: true, force: true });
      }
    },
  );

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
