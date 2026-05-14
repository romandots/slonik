import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Манифест bootstrap'а. Источник правды для конкретной установки —
// bootstrap/manifest.yaml (gitignored). Если он отсутствует, loader падает
// обратно на committed-шаблон bootstrap/manifest.example.yaml — это
// pristine-дефолт, который едет в репозитории и в Docker-образе.
//
// Сценарий кастомизации (по аналогии с .env.example → .env): пользователь
// копирует manifest.example.yaml → manifest.yaml, правит под свой инстанс
// (добавляет проекты, меняет идентичности) и пересобирает образ. Файл
// manifest.yaml в git не едет (см. .gitignore).

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

const StateGroup = z.enum([
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
]);

export const ManifestSchema = z.object({
  workspace: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
  projects: z
    .array(
      z.object({
        slug: z.string().min(1),
        // Plane v1.3.0 валидирует project.name на бэкенде и режет всё, что
        // не подходит под `[A-Za-z0-9 _-]+`, 400-ой с сообщением
        // "Project name cannot contain special characters." Прогоняем тот
        // же regex локально — иначе один кривой `name` (точка, em-dash,
        // двоеточие, slash и пр.) укладывает Plane по сети, а у нас
        // bootstrap-цикл прерывается на первом же проекте. Лучше упасть
        // на zod-валидации с понятным сообщением, чем ходить в Plane.
        name: z
          .string()
          .min(1)
          .regex(
            /^[A-Za-z0-9 _-]+$/,
            'Plane project name must match /^[A-Za-z0-9 _-]+$/ (no dots/em-dashes/special chars)',
          ),
        identifier: z.string().min(1).max(12),
        modules: z.array(z.enum(['cycles', 'modules', 'views', 'pages'])).default([]),
      }),
    )
    .min(1),
  states: z
    .array(
      z.object({
        name: z.string().min(1),
        group: StateGroup,
        color: HexColor,
        order: z.number().int().positive(),
        default: z.boolean().optional(),
      }),
    )
    .min(1),
  labels: z
    .array(
      z.object({
        name: z.string().min(1),
        color: HexColor,
      }),
    )
    .min(1),
  identities: z
    .array(
      z.object({
        role: z.string().min(1),
        email: z.string().email(),
        first_name: z.string().min(1),
        last_name: z.string().min(1),
        default_state: z.string().min(1),
      }),
    )
    .min(1),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export interface LoadManifestOptions {
  path?: string;
}

export function loadManifest(opts: LoadManifestOptions = {}): Manifest {
  const path = opts.path ?? defaultManifestPath();
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid bootstrap manifest (${path}):\n${issues}`);
  }
  return result.data;
}

function defaultManifestPath(): string {
  // В dev (tsx) лежим в /src/bootstrap; в prod (dist) — в /dist/bootstrap.
  // bootstrap/ — рядом с package.json, поэтому поднимаемся на 2 уровня
  // от текущего файла. Сначала ищем локальный manifest.yaml (gitignored,
  // конфиг конкретной установки), при отсутствии — fallback на
  // committed-шаблон manifest.example.yaml.
  const here = dirname(fileURLToPath(import.meta.url));
  const bootstrapDir = join(here, '..', '..', 'bootstrap');
  const local = join(bootstrapDir, 'manifest.yaml');
  if (existsSync(local)) return local;
  return join(bootstrapDir, 'manifest.example.yaml');
}
