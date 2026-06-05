import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { addRoleCli } from './add-role.js';
import { loadRoles } from './roles.js';

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'slonk-add-role-'));
}

function memOutput(): { stream: Writable; text(): string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

function memInput(lines: readonly string[]): PassThrough {
  // readline.question rejects with "readline was closed" если stream
  // EOF'нулся между вопросами; используем PassThrough, который не
  // ending'ится — readline закроет его сам, когда addRoleCli вызовет
  // rl.close(). Пишем строки на nextTick, чтобы readline успел
  // подписаться на 'line' до доставки данных.
  const stream = new PassThrough();
  process.nextTick(() => {
    for (const l of lines) {
      stream.write(`${l}\n`);
    }
  });
  return stream;
}

describe('addRoleCli', () => {
  it('writes a valid role file from --flag arguments (non-interactive)', async () => {
    const dir = newDir();
    try {
      const out = memOutput();
      const result = await addRoleCli({
        dir,
        output: out.stream,
        argv: [
          '--role',
          'release-agent',
          '--email',
          'release@slonk.local',
          '--first-name',
          'Release',
          '--last-name',
          'Agent',
          '--default-state',
          'Releasing',
          '--state-alias',
          'Релиз',
          '--state-alias',
          'Shipping',
        ],
      });
      expect(result.role.role).toBe('release-agent');
      expect(result.role.state_aliases).toEqual(['Релиз', 'Shipping']);
      expect(result.path).toBe(join(dir, 'release-agent.md'));

      const content = readFileSync(result.path, 'utf8');
      expect(content).toMatch(/^---\n/);
      expect(content).toContain('role: release-agent');
      expect(content).toContain('default_state: Releasing');
      expect(content).toContain('Релиз');

      // Прогон через loader — гарантия, что bootstrap прочитает то, что
      // мы только что положили (нет cross-валидации regression'а).
      const loaded = loadRoles({ dir });
      expect(loaded.found).toBe(true);
      expect(loaded.roles).toHaveLength(1);
      expect(loaded.roles[0]!.role).toBe('release-agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes role file from interactive answers', async () => {
    const dir = newDir();
    try {
      const out = memOutput();
      const input = memInput([
        'i18n-agent', // role
        'i18n@slonk.local', // email
        'I18n', // first_name
        'Agent', // last_name
        'Translation', // default_state
        'Перевод, Localization', // state_aliases
      ]);
      const result = await addRoleCli({ dir, input, output: out.stream });
      expect(result.role.role).toBe('i18n-agent');
      expect(result.role.state_aliases).toEqual(['Перевод', 'Localization']);

      const loaded = loadRoles({ dir });
      expect(loaded.roles.map((r) => r.role)).toEqual(['i18n-agent']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-prompts on invalid input until validation passes', async () => {
    const dir = newDir();
    try {
      const out = memOutput();
      const input = memInput([
        'BadName', // role: rejected (uppercase)
        '', // re-prompt: empty rejected
        'release-agent', // accepted
        'not-an-email', // email: rejected
        'release@slonk.local', // accepted
        'R', // first_name ok
        'A', // last_name ok
        'Releasing', // default_state ok
        '', // no aliases
      ]);
      const result = await addRoleCli({ dir, input, output: out.stream });
      expect(result.role.role).toBe('release-agent');
      expect(result.role.email).toBe('release@slonk.local');
      expect(result.role.state_aliases).toEqual([]);

      const log = out.text();
      // На неверный role и email должны были вывести сообщение об ошибке.
      expect(log).toMatch(/role must be lowercase/i);
      expect(log).toMatch(/invalid.*email/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite existing role file without --force', async () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, 'release-agent.md'), '---\nrole: release-agent\n---\n');
      const out = memOutput();
      await expect(
        addRoleCli({
          dir,
          output: out.stream,
          argv: [
            '--role',
            'release-agent',
            '--email',
            'r@x.local',
            '--first-name',
            'R',
            '--last-name',
            'A',
            '--default-state',
            'X',
          ],
        }),
      ).rejects.toThrow(/already exists/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites with --force', async () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, 'release-agent.md'), 'old content\n');
      const out = memOutput();
      const result = await addRoleCli({
        dir,
        output: out.stream,
        argv: [
          '--role',
          'release-agent',
          '--email',
          'r@x.local',
          '--first-name',
          'R',
          '--last-name',
          'A',
          '--default-state',
          'Releasing',
          '--force',
        ],
      });
      const content = readFileSync(result.path, 'utf8');
      expect(content).not.toContain('old content');
      expect(content).toContain('role: release-agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown flags with usage hint', async () => {
    const dir = newDir();
    try {
      await expect(
        addRoleCli({ dir, output: memOutput().stream, argv: ['--what'] }),
      ).rejects.toThrow(/Unknown argument: --what/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --flag without value', async () => {
    const dir = newDir();
    try {
      await expect(
        addRoleCli({ dir, output: memOutput().stream, argv: ['--role'] }),
      ).rejects.toThrow(/requires a value/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid prefilled value with field name in error', async () => {
    const dir = newDir();
    try {
      await expect(
        addRoleCli({
          dir,
          output: memOutput().stream,
          argv: [
            '--role',
            'BadName',
            '--email',
            'r@x.local',
            '--first-name',
            'R',
            '--last-name',
            'A',
            '--default-state',
            'X',
          ],
        }),
      ).rejects.toThrow(/role.*lowercase/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the roles dir if missing', async () => {
    const base = newDir();
    const dir = join(base, 'nested', 'roles');
    try {
      const out = memOutput();
      const result = await addRoleCli({
        dir,
        output: out.stream,
        argv: [
          '--role',
          'release-agent',
          '--email',
          'r@x.local',
          '--first-name',
          'R',
          '--last-name',
          'A',
          '--default-state',
          'Releasing',
        ],
      });
      expect(result.path).toBe(join(dir, 'release-agent.md'));
      const loaded = loadRoles({ dir });
      expect(loaded.roles).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('strips state_aliases section when empty (clean markdown)', async () => {
    const dir = newDir();
    try {
      const out = memOutput();
      const result = await addRoleCli({
        dir,
        output: out.stream,
        argv: [
          '--role',
          'lean-agent',
          '--email',
          'l@x.local',
          '--first-name',
          'L',
          '--last-name',
          'A',
          '--default-state',
          'Doing',
        ],
      });
      const content = readFileSync(result.path, 'utf8');
      expect(content).not.toContain('state_aliases');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
