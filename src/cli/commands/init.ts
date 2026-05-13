import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../io.js';

// Pruned during manifest discovery — mirrors the default `ignore` /
// `vendor` defaults but is hard-coded here because init runs before any
// config exists.
const PRUNE_DIR_NAMES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.git',
  '.ti',
]);
const MAX_DETECT_DEPTH = 4;

export interface InitCommandOpts {
  readonly projectRoot: string;
  readonly io: Io;
}

interface Detected {
  readonly phpunit: boolean;
  readonly jest: boolean;
  readonly vitest: boolean;
  readonly playwright: boolean;
}

export function initCommand(opts: InitCommandOpts): Promise<number> {
  const { projectRoot, io } = opts;

  // Ensure .ti/ exists regardless.
  const tiDir = join(projectRoot, '.ti');
  if (!existsSync(tiDir)) {
    try {
      mkdirSync(tiDir, { recursive: true });
    } catch (e) {
      io.stderr.write(`ti: error: failed to create .ti/: ${(e as Error).message}\n`);
      return Promise.resolve(1);
    }
  }

  const configPath = join(projectRoot, 'ti.config.ts');
  if (existsSync(configPath)) {
    io.stderr.write(`ti: ti.config.ts already exists - leaving it untouched\n`);
    return Promise.resolve(0);
  }

  const detected = detect(projectRoot);
  const content = renderStarterConfig(detected);
  try {
    writeFileSync(configPath, content, { encoding: 'utf8' });
  } catch (e) {
    io.stderr.write(`ti: error: failed to write ti.config.ts: ${(e as Error).message}\n`);
    return Promise.resolve(1);
  }
  return Promise.resolve(0);
}

function detect(projectRoot: string): Detected {
  let phpunit = false;
  let jest = false;
  let vitest = false;
  let playwright = false;

  for (const manifest of findManifests(projectRoot, MAX_DETECT_DEPTH)) {
    if (manifest.file === 'composer.json') {
      if (
        readJsonAtFile(manifest.absPath, ['require-dev', 'phpunit/phpunit']) !== null ||
        readJsonAtFile(manifest.absPath, ['require', 'phpunit/phpunit']) !== null
      ) {
        phpunit = true;
      }
    } else {
      if (readJsonAtFile(manifest.absPath, ['devDependencies', 'jest']) !== null) jest = true;
      if (readJsonAtFile(manifest.absPath, ['devDependencies', 'vitest']) !== null) vitest = true;
      if (readJsonAtFile(manifest.absPath, ['devDependencies', '@playwright/test']) !== null) {
        playwright = true;
      }
    }
  }

  return { phpunit, jest, vitest, playwright };
}

interface FoundManifest {
  readonly absPath: string;
  readonly file: 'package.json' | 'composer.json';
}

function* findManifests(root: string, maxDepth: number): Iterable<FoundManifest> {
  yield* walkForManifests(root, root, 0, maxDepth);
}

function* walkForManifests(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
): Iterable<FoundManifest> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'package.json' || e.name === 'composer.json') {
      const full = join(dir, e.name);
      try {
        if (statSync(full).isFile()) {
          yield { absPath: full, file: e.name };
        }
      } catch {
        // ignore
      }
    }
  }
  if (depth >= maxDepth) return;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (PRUNE_DIR_NAMES.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.') continue;
    yield* walkForManifests(root, join(dir, e.name), depth + 1, maxDepth);
  }
}

function readJsonAtFile(absPath: string, path: readonly string[]): unknown {
  if (!existsSync(absPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  let cur: unknown = parsed;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur ?? null;
}

function renderStarterConfig(d: Detected): string {
  const blocks: string[] = [];
  if (d.phpunit) {
    blocks.push(`    phpunit: {
      baseClasses: ['PHPUnit\\\\Framework\\\\TestCase'],
      methodPatterns: ['test*', '@test', '#[Test]'],
    },`);
  }
  if (d.jest || d.vitest) {
    blocks.push(`    jest: {
      fileGlobs: ['**/*.test.{ts,tsx,js,jsx}', '**/*.spec.{ts,tsx,js,jsx}'],
    },`);
  }
  if (d.playwright) {
    blocks.push(`    playwright: {
      // Discovery uses playwright.config.* testDir/testMatch if present.
    },`);
  }
  const testsBlock =
    blocks.length === 0
      ? `  // tests: { phpunit: { ... }, jest: { ... } },`
      : `  tests: {\n${blocks.join('\n')}\n    classes: [],\n    defaultClass: 'unit',\n  },`;

  return `export default {
${testsBlock}
  // hooks: { stopList: { add: [], remove: [] } },
  // extractors: [],
  // confidence: { weights: {}, threshold: 0.0 },
  // traversal: { maxDepth: 25, maxMillisPerTest: 5000 },
  // concurrency: { phpWorkers: undefined, tsWorkers: undefined, deriveWorkers: undefined },
  // ignore: ['**/node_modules', '**/node_modules/**', '**/dist', '**/dist/**', '**/build', '**/build/**', '**/.git', '**/.git/**'],
  // vendor: ['**/vendor', '**/vendor/**'],
};
`;
}
