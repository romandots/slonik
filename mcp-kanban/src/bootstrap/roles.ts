import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import type { Logger } from '../logger.js';

// Loader для директории `roles/` — основной источник agent-identities
// начиная с SLONK-6.
//
// Каждая роль — один markdown-файл с YAML front-matter (между двумя `---`).
// Body markdown игнорируется (он для оператора, не для bootstrap'а). Loader
// читает все `*.md` файлы в директории, валидирует front-matter zod-схемой,
// возвращает плоский массив `RoleDefinition[]`.
//
// Контракт source of truth — этот файл. Поведение fallback'а на
// `manifest.yaml.identities` живёт в `runner.ts`: если `loadRoles()` вернул
// пустой массив (директория пустая / отсутствует), runner возьмёт
// `manifest.identities` — это путь обратной совместимости для инсталляций,
// обновляющихся с версии без `roles/`.

export const RoleDefinitionSchema = z.object({
  role: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'role must be lowercase with dashes (e.g. "developer-agent")'),
  email: z.string().email(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  default_state: z.string().min(1),
  // state_aliases — необязательный список синонимов имени `default_state`.
  // Используется `claim_issue` для резолва имени колонки в `state_id`, когда
  // канбан настроен с переименованными колонками (другой язык, другой стиль).
  state_aliases: z.array(z.string().min(1)).default([]),
});

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export interface LoadRolesOptions {
  /** Путь до директории с `*.md`-файлами. По умолчанию — `<root>/roles`. */
  dir?: string;
  /**
   * Опциональный pino-логгер. Если передан, loader пишет одну warn-строку
   * на каждый пропущенный нерегулярный файл (symlink, directory, FIFO и т.п.).
   * В логе НЕТ содержимого / цели — только имя записи в `roles/` и её тип,
   * чтобы не раскрывать через лог структуру хоста, на которую указывает
   * подсунутый симлинк.
   */
  logger?: Logger;
}

export interface LoadRolesResult {
  /** Путь, по которому loader реально искал роли (для логов / debug'а). */
  path: string;
  /** Список ролей в детерминированном порядке (сортировка по `role`). */
  roles: RoleDefinition[];
  /** True если директория существует и в ней есть `*.md`-файлы. */
  found: boolean;
}

/**
 * Читает все `*.md` файлы в `roles/`-директории и парсит из них
 * YAML front-matter. Возвращает результат даже если директория пустая
 * или отсутствует — вызывающий (`runner.ts`) решает, что делать
 * (fallback на manifest или ошибка).
 *
 * Падает loudly только если файл существует, но его front-matter не
 * проходит zod-валидацию — это явный конфиг-баг пользователя, его надо
 * показать сразу, а не маскировать тихим fallback'ом.
 */
export function loadRoles(opts: LoadRolesOptions = {}): LoadRolesResult {
  const path = opts.dir ?? defaultRolesDir();
  if (!existsSync(path)) {
    return { path, roles: [], found: false };
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    throw new Error(
      `Roles path is not a directory: ${path}. Set MCP_ROLES_DIR to a directory or remove the file.`,
    );
  }
  // SLONK-10: используем `withFileTypes: true`, чтобы получить `Dirent`'ы и
  // отфильтровать всё, что не является регулярным файлом. `Dirent.isFile()`
  // для симлинка возвращает `false` (документированное поведение Node), цель
  // ссылки не резолвится — а значит подсунутый `evil.md -> /etc/passwd` будет
  // молча пропущен ещё до любого `readFileSync`. Это defense-in-depth поверх
  // того, что `MCP_ROLES_DIR` уже монтируется в контейнер как `:ro` и
  // редактируется только тем, у кого write-доступ к репозиторию / хосту.
  const entries = readdirSync(path, { withFileTypes: true });
  const mdFiles: string[] = [];
  for (const dirent of entries) {
    if (extname(dirent.name).toLowerCase() !== '.md') continue;
    if (!dirent.isFile()) {
      // Логируем только имя записи и её тип. Цель симлинка / содержимое
      // НЕ попадают в лог — иначе атакующий смог бы через подсунутый
      // `evil.md -> /etc/passwd` выгрузить первую строку файла в stderr.
      opts.logger?.warn(
        { name: dirent.name, kind: direntKind(dirent) },
        'roles loader: skipping non-regular entry',
      );
      continue;
    }
    mdFiles.push(dirent.name);
  }
  // README.md и любой другой служебный файл — кастомизация формата контракта
  // обозначена front-matter'ом. Если в файле НЕТ YAML front-matter'а — он
  // не описывает роль, и мы пропускаем его без ошибки (для README.md это
  // штатное поведение). Это локализует «правило README» в одном месте.
  const roles: RoleDefinition[] = [];
  for (const name of mdFiles.sort()) {
    const full = join(path, name);
    const raw = readFileSync(full, 'utf8');
    const frontMatter = extractFrontMatter(raw);
    if (frontMatter === null) {
      // Не описывает роль — skip без шума. Типичный кейс: README.md.
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(frontMatter);
    } catch (err) {
      if (err instanceof YAMLParseError) {
        const pos = err.linePos?.[0];
        const where = pos !== undefined ? `line ${pos.line}, col ${pos.col}` : 'unknown position';
        throw new Error(
          `Invalid YAML in role front-matter (${full}):\n` +
            `  ${where}: ${err.message}\n` +
            '\n' +
            'Hint: front-matter is the YAML block between the first two `---` lines.',
        );
      }
      throw err;
    }
    const result = RoleDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid role definition (${full}):\n${issues}`);
    }
    roles.push(result.data);
  }
  // Детерминированный порядок: одна и та же установка должна давать
  // идентичный набор identities при каждом bootstrap'е (это упрощает
  // diff в audit-логах).
  roles.sort((a, b) => a.role.localeCompare(b.role));
  // Pre-check на дубликаты role: zod схема валидирует один файл, но не
  // отношения между файлами. Если оператор скопировал developer-agent.md
  // под другим именем и забыл сменить `role:`, bootstrap должен упасть
  // с понятным сообщением, а не молча затереть upsert'ом.
  const seen = new Set<string>();
  for (const r of roles) {
    if (seen.has(r.role)) {
      throw new Error(
        `Duplicate role definition '${r.role}' in ${path}. ` +
          'Each role must have a unique `role:` field across all *.md files.',
      );
    }
    seen.add(r.role);
  }
  return { path, roles, found: roles.length > 0 };
}

/**
 * Возвращает true, если файл начинается с YAML front-matter (`---\n...\n---\n`).
 * Используется, чтобы отличать role-файлы от README и пр.
 */
function extractFrontMatter(raw: string): string | null {
  // Front-matter ДОЛЖЕН начинаться с `---` на первой строке. Trim'аем
  // только BOM, не пробелы — markdown с пустыми строками в самом начале
  // (вместо front-matter'а) — это просто markdown без метаданных.
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return null;
  // Поддерживаем оба окончания строк (`\n` / `\r\n`).
  // Первый разделитель: `---\n` или `---\r\n`.
  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) return null;
  const afterOpening = text.slice(firstNewline + 1);
  // Ищем закрывающий разделитель `---` на отдельной строке.
  const closingMatch = afterOpening.match(/^---\s*$/m);
  if (closingMatch === null || closingMatch.index === undefined) return null;
  return afterOpening.slice(0, closingMatch.index);
}

/**
 * Возвращает короткое human-readable имя типа `Dirent`'а для лога.
 * Намеренно избегаем `lstatSync`/`statSync` — они потенциально следуют за
 * ссылкой / делают лишний syscall; `Dirent` уже знает свой тип.
 */
function direntKind(dirent: {
  isSymbolicLink: () => boolean;
  isDirectory: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
}): string {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFIFO()) return 'fifo';
  if (dirent.isSocket()) return 'socket';
  if (dirent.isBlockDevice()) return 'block-device';
  if (dirent.isCharacterDevice()) return 'character-device';
  return 'other';
}

function defaultRolesDir(): string {
  // В dev (tsx) лежим в /src/bootstrap; в prod (dist) — в /dist/bootstrap.
  // roles/ — рядом с package.json (на уровне с bootstrap/), поэтому
  // поднимаемся на 2 уровня от текущего файла.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'roles');
}
