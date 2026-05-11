import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Манифест bootstrap'а. Источник правды — bootstrap/manifest.yaml в
// пакете mcp-kanban. Файл копируется в образ; при изменении содержимого —
// меняется только yaml, код не трогается, если контракт не меняется.

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
        name: z.string().min(1),
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
  // bootstrap/manifest.yaml — рядом с package.json, поэтому поднимаемся
  // на 2 уровня от текущего файла.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'bootstrap', 'manifest.yaml');
}
