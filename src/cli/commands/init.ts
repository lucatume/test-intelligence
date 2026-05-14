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
  // Project-relative POSIX directories that contain a playwright.config.*
  readonly playwrightConfigDirs: readonly string[];
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
  const playwrightConfigDirs: string[] = [];

  for (const found of findRelevantFiles(projectRoot, MAX_DETECT_DEPTH)) {
    if (found.kind === 'composer') {
      if (
        readJsonAtFile(found.absPath, ['require-dev', 'phpunit/phpunit']) !== null ||
        readJsonAtFile(found.absPath, ['require', 'phpunit/phpunit']) !== null
      ) {
        phpunit = true;
      }
    } else if (found.kind === 'package') {
      if (readJsonAtFile(found.absPath, ['devDependencies', 'jest']) !== null) jest = true;
      if (readJsonAtFile(found.absPath, ['devDependencies', 'vitest']) !== null) vitest = true;
      if (readJsonAtFile(found.absPath, ['devDependencies', '@playwright/test']) !== null) {
        playwright = true;
      }
    } else {
      // playwright.config.* — the parent dir is the implied test root.
      playwright = true;
      playwrightConfigDirs.push(found.relDir);
    }
  }

  return { phpunit, jest, vitest, playwright, playwrightConfigDirs };
}

type FoundKind = 'package' | 'composer' | 'playwright';
const PLAYWRIGHT_CONFIG_RE = /^playwright\.config\.(?:[mc]?[tj]s)$/;

interface FoundFile {
  readonly absPath: string;
  readonly relDir: string;
  readonly kind: FoundKind;
}

function* findRelevantFiles(root: string, maxDepth: number): Iterable<FoundFile> {
  yield* walkForFiles(root, root, 0, maxDepth);
}

function* walkForFiles(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
): Iterable<FoundFile> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const kind: FoundKind | null =
      e.name === 'package.json' ? 'package'
      : e.name === 'composer.json' ? 'composer'
      : PLAYWRIGHT_CONFIG_RE.test(e.name) ? 'playwright'
      : null;
    if (kind === null) continue;
    const full = join(dir, e.name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const relDir = toPosixRelDir(root, dir);
    yield { absPath: full, relDir, kind };
  }
  if (depth >= maxDepth) return;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (PRUNE_DIR_NAMES.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.') continue;
    yield* walkForFiles(root, join(dir, e.name), depth + 1, maxDepth);
  }
}

function toPosixRelDir(root: string, dir: string): string {
  if (dir === root) return '';
  // join uses platform sep — switch to posix here so the glob we emit is portable.
  const rel = dir.slice(root.length).replace(/^[/\\]+/, '');
  return rel.split(/[/\\]/).join('/');
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

// When playwright.config.* files are found, derive globs anchored at their
// parent directories — those are the strongest signal for where pw tests
// actually live. Otherwise fall back to conventional directory names; we
// deliberately keep these narrow so a generic *.spec.ts elsewhere is still
// classified as jest.
function formatPlaywrightGlobs(configDirs: readonly string[]): string {
  const exts = '{ts,tsx,js,jsx}';
  let globs: string[];
  if (configDirs.length > 0) {
    globs = configDirs.flatMap((d) => [
      `${d}/**/*.spec.${exts}`,
      `${d}/**/*.test.${exts}`,
    ]);
  } else {
    globs = [
      `**/e2e-pw/**/*.spec.${exts}`,
      `**/e2e_pw/**/*.spec.${exts}`,
      `**/playwright/**/*.spec.${exts}`,
    ];
  }
  return `[${globs.map((g) => `'${g}'`).join(', ')}]`;
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
      fileGlobs: ${formatPlaywrightGlobs(d.playwrightConfigDirs)},
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
  // ignore extends the built-in default ignore bundles. Toggle individual
  // bundles with ignoreDefaults (each defaults to true).
  // ignore: ['**/my-output', '**/my-output/**'],
  // ignoreDefaults: { agenticWorktrees: true, toolDirs: true, testArtifacts: true, buildCaches: true, minified: true },
  // vendor: ['**/vendor', '**/vendor/**'],
};
`;
}
