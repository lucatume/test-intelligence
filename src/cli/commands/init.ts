import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../io.js';

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
  const phpunit =
    readJsonField(projectRoot, 'composer.json', ['require-dev', 'phpunit/phpunit']) !== null ||
    readJsonField(projectRoot, 'composer.json', ['require', 'phpunit/phpunit']) !== null;
  const jest = readJsonField(projectRoot, 'package.json', ['devDependencies', 'jest']) !== null;
  const vitest = readJsonField(projectRoot, 'package.json', ['devDependencies', 'vitest']) !== null;
  const playwright =
    readJsonField(projectRoot, 'package.json', ['devDependencies', '@playwright/test']) !== null;
  return { phpunit, jest, vitest, playwright };
}

function readJsonField(projectRoot: string, file: string, path: readonly string[]): unknown {
  const fp = join(projectRoot, file);
  if (!existsSync(fp)) return null;
  let raw: string;
  try {
    raw = readFileSync(fp, 'utf8');
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
  // ignore: ['node_modules/**', 'dist/**', 'build/**'],
  // vendor: ['vendor/**'],
};
`;
}
