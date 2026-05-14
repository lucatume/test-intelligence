import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '../result.js';
import { acquireLock, releaseLock } from '../store/lock.js';
import { openStore } from '../store/open.js';
import {
  upsertFile,
  insertFact,
  upsertAnchor,
  insertFactAnchor,
  insertTest,
} from '../store/writers.js';
import { walk } from '../discover/walk.js';
import { classifyFile } from '../discover/framework.js';
import { matchesAny } from '../discover/glob.js';
import { extractFile } from '../extract/index.js';
import { CompilerOptionsResolver } from '../extract/ts/compiler.js';
import { hasPhpAvailable, type PhpWorker } from '../extract/php/spawn.js';
import { startPhpWorkerPool } from '../extract/php/pool.js';
import { startTsWorkerPool, type TsWorkerPool } from '../extract/ts/pool.js';
import { WP_PHP_PATTERNS } from '../extract/declarative/wp-php-patterns.js';
import { WP_JS_PATTERNS } from '../extract/declarative/wp-js-patterns.js';
import type { Fact } from '../facts/types.js';
import type { ExtractError } from '../extract/types.js';
import type { Language } from '../types.js';
import { parseProjectRelativePath } from '../paths.js';
import { parseAnchor } from '../anchors/parse.js';
import { derive } from '../derive/derive.js';
import { HOOK_STOP_LIST_BUILTINS, type ValidatedConfig } from '../config/parse.js';
import type { BuildOptions, BuildSummary, BuildError } from './types.js';
import type { DiscoveredFile } from '../discover/types.js';

export async function runBuild(opts: BuildOptions): Promise<Result<BuildSummary, BuildError>> {
  const startMs = opts.clock.nowMillis();
  const verbosity = opts.verbosity ?? 'normal';

  const sRes = openStore(opts.projectRoot);
  if (sRes.kind === 'err') return err({ kind: 'BuildError', message: sRes.error.message });
  const { db, close } = sRes.value;

  const lockRes = acquireLock(opts.projectRoot, {
    command: opts.onlyPaths !== undefined ? 'update' : 'build',
    clock: opts.clock,
  });
  if (lockRes.kind === 'err') {
    close();
    return err({ kind: 'BuildError', message: `lock: ${lockRes.error.kind}` });
  }

  try {

    let filesExtracted = 0;
    let factsInserted = 0;
    let testsFound = 0;
    let worker: PhpWorker | undefined;
    let tsPool: TsWorkerPool | undefined;

    try {
      const repoRoot = opts.repoRoot ?? resolveRepoRoot();
      const phpWorkers = resolvePhpWorkers(opts.config.concurrency.phpWorkers);
      const tsWorkers = resolveTsWorkers(opts.config.concurrency.tsWorkers);
      if (mayHavePhp(opts) && hasPhpAvailable()) {
        const wRes = startPhpWorkerPool({ repoRoot, size: phpWorkers });
        if (wRes.kind === 'ok') {
          worker = wRes.value;
          await worker.registerPatterns(WP_PHP_PATTERNS);
        } else if (verbosity !== 'quiet') {
          opts.stderr.write(
            `ti: php worker unavailable (${wRes.error.message}) — PHP files will be skipped\n`,
          );
        }
      }
      if (tsWorkers > 0) {
        tsPool = startTsWorkerPool({ projectRoot: opts.projectRoot, size: tsWorkers });
      }

      const compilerOptionsResolver = tsPool === undefined
        ? new CompilerOptionsResolver(opts.projectRoot)
        : null;
      const source = opts.onlyPaths !== undefined
        ? listFromPaths(opts.onlyPaths, opts.projectRoot, opts.config, opts.stderr, verbosity)
        : walk(opts.projectRoot, opts.config);
      const it = toAsyncIterator(source);

      // Lane count is the larger of the two pool sizes — saturates the bigger
      // pool while letting the smaller queue. SQLite writes are synchronous
      // and serialize naturally between the lanes' awaits.
      const laneCount = Math.max(phpWorkers, tsWorkers, 1);
      const lanes: Promise<void>[] = [];
      for (let i = 0; i < laneCount; i++) {
        lanes.push((async (): Promise<void> => {
          for (;;) {
            const next = await it.next();
            if (next.done === true) return;
            const file = next.value;
            const text = await readFile(join(opts.projectRoot, file.path), 'utf8').catch(() => null);
            if (text === null) {
              if (verbosity === 'verbose') opts.stderr.write(`ti: skipped (read failed) ${file.path}\n`);
              continue;
            }
            const contentHash = createHash('sha1').update(text).digest('hex');
            const r = await dispatchExtract({
              file,
              text,
              projectRoot: opts.projectRoot,
              tsPool,
              phpWorker: worker,
              compilerOptionsResolver,
            });
            if (r.kind === 'err') {
              if (verbosity !== 'quiet') {
                opts.stderr.write(`ti: extract failed ${file.path}: ${r.error.message}\n`);
              }
              continue;
            }

            // From here down all DB calls are synchronous. Multiple lanes will
            // interleave at `await` points only — never inside this block.
            const fileId = upsertFile(db, {
              path: file.path,
              language: file.language,
              contentHash,
              extractedAt: opts.clock.now(),
              isTest: file.framework !== null,
              framework: file.framework,
              frameworkClass: file.frameworkClass,
            });
            filesExtracted++;
            for (const f of r.value) {
              const factId = insertFact(db, {
                fileId,
                kind: f.kind,
                resolved: f.resolved,
                startLine: f.location.startLine,
                endLine: f.location.endLine,
                payload: f.payload,
              });
              factsInserted++;
              for (const a of f.anchors) {
                const parsed = parseAnchor(a.key);
                if (parsed.kind === 'err') continue;
                const anchorId = upsertAnchor(db, { key: parsed.value.key, type: parsed.value.type });
                insertFactAnchor(db, { factId, anchorId, role: a.role });
              }
              if (f.kind === 'test-def' && file.framework !== null) {
                const payload = f.payload as { testId?: unknown; framework?: unknown };
                if (typeof payload.testId === 'string' && typeof payload.framework === 'string') {
                  insertTest(db, {
                    testId: payload.testId,
                    fileId,
                    framework: payload.framework,
                    frameworkClass: file.frameworkClass ?? 'unit',
                    factId,
                  });
                  testsFound++;
                }
              }
            }
            if (verbosity === 'verbose') {
              opts.stderr.write(`ti: extracted ${file.path} (${String(r.value.length)} facts)\n`);
            }
          }
        })());
      }
      await Promise.all(lanes);

      const stopList = new Set<string>(HOOK_STOP_LIST_BUILTINS);
      for (const h of opts.config.hooks.stopList.add) stopList.add(h);
      for (const h of opts.config.hooks.stopList.remove) stopList.delete(h);

      const deriveSummary = await derive({
        db,
        clock: opts.clock,
        params: {
          maxDepth: opts.config.traversal.maxDepth,
          maxMillisPerTest: opts.config.traversal.maxMillisPerTest,
          threshold: opts.config.confidence.threshold,
          hookStopList: stopList,
        },
        workers: resolveDeriveWorkers(opts.config.concurrency.deriveWorkers),
      });

      const elapsedMillis = opts.clock.nowMillis() - startMs;
      const summary: BuildSummary = {
        filesExtracted,
        factsInserted,
        testsFound,
        edgesWritten: deriveSummary.edgesWritten,
        testsBounded: deriveSummary.testsBounded,
        elapsedMillis,
      };
      if (verbosity !== 'quiet') {
        opts.stderr.write(
          `ti: build complete — ${String(filesExtracted)} files, ${String(factsInserted)} facts, ` +
          `${String(testsFound)} tests, ${String(deriveSummary.edgesWritten)} edges` +
          (deriveSummary.testsBounded > 0 ? ` (${String(deriveSummary.testsBounded)} bounded)` : '') +
          ` in ${String(elapsedMillis)}ms\n`,
        );
      }
      return ok(summary);
    } finally {
      if (worker) await worker.shutdown();
      if (tsPool) await tsPool.shutdown();
      close();
    }
  } finally {
    releaseLock(opts.projectRoot);
  }
}

function toAsyncIterator<T>(src: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> {
  if (Symbol.asyncIterator in src) {
    return src[Symbol.asyncIterator]();
  }
  const sync = src[Symbol.iterator]();
  const wrapped: AsyncIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      return Promise.resolve(sync.next());
    },
  };
  return wrapped;
}

// Resolve the PHP worker pool size. Default: cpus-2 clamped to [1,8] — most
// developer laptops have 8-12 cores, leaving headroom for the main thread and
// the OS. 0 / negative is treated as 1 so the single-worker fallback is always
// available.
function resolvePhpWorkers(configured: number | undefined): number {
  if (configured === undefined) {
    return Math.min(Math.max(cpus().length - 2, 1), 8);
  }
  return Math.max(configured, 1);
}

// Resolve the derive worker_threads pool size. Default: cpus-2 clamped to
// [0,8]. 0 disables workers and runs traversal in-process — that is the right
// default for tiny projects where worker startup + structured-clone of the
// graph dominates BFS time.
function resolveDeriveWorkers(configured: number | undefined): number {
  if (configured === undefined) {
    return Math.min(Math.max(cpus().length - 2, 0), 8);
  }
  return Math.max(configured, 0);
}

// Resolve the TS extractor pool size. Default: cpus-2 clamped to [0,4].
// Smaller cap than PHP because each worker holds its own typescript import
// plus a per-dir tsconfig cache (~40MB+). 0 keeps TS extraction in-process.
function resolveTsWorkers(configured: number | undefined): number {
  if (configured === undefined) {
    return Math.min(Math.max(cpus().length - 2, 0), 4);
  }
  return Math.max(configured, 0);
}

const TS_LANGUAGES: ReadonlySet<Language> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
] as const);

interface DispatchInput {
  readonly file: DiscoveredFile;
  readonly text: string;
  readonly projectRoot: string;
  readonly tsPool: TsWorkerPool | undefined;
  readonly phpWorker: PhpWorker | undefined;
  readonly compilerOptionsResolver: CompilerOptionsResolver | null;
}

// dispatchExtract picks the right execution path per file: TS files go to the
// ts worker pool when available, PHP files go through the existing extractFile
// + PHP worker pool, everything else falls back to in-process extractFile.
async function dispatchExtract(input: DispatchInput): Promise<Result<readonly Fact[], ExtractError>> {
  const { file } = input;
  if (input.tsPool && TS_LANGUAGES.has(file.language)) {
    try {
      const facts = await input.tsPool.extract({
        relPath: file.path,
        language: file.language,
        framework: file.framework,
        source: input.text,
        // Match extract/index.ts: WP_JS_PATTERNS are part of the built-in
        // pattern set for TS extraction. User patterns sit on top.
        patterns: WP_JS_PATTERNS,
      });
      return ok(facts);
    } catch (e) {
      return err({ kind: 'ExtractError', path: file.path, message: e instanceof Error ? e.message : String(e) });
    }
  }
  // In-process path needs a resolver. If the TS pool is on, we don't keep one
  // around for PHP files (PHP dispatch ignores compilerOptions).
  const resolver = input.compilerOptionsResolver ?? new CompilerOptionsResolver(input.projectRoot);
  const compilerOptions = resolver.forFile(join(input.projectRoot, file.path));
  return extractFile({
    projectRoot: input.projectRoot,
    path: file.path,
    language: file.language,
    framework: file.framework,
    compilerOptions,
    patterns: [],
    ...(input.phpWorker !== undefined ? { phpWorker: input.phpWorker } : {}),
  });
}

function* listFromPaths(
  paths: readonly string[],
  projectRoot: string,
  config: ValidatedConfig,
  stderr: { write(s: string): void },
  verbosity: 'quiet' | 'normal' | 'verbose',
): Iterable<DiscoveredFile> {
  for (const raw of paths) {
    const parsed = parseProjectRelativePath(raw, projectRoot, {
      allowSymlinkTargets: config.allowSymlinkTargets,
    });
    if (parsed.kind === 'err') {
      if (verbosity !== 'quiet') stderr.write(`ti: unknown path ${raw}\n`);
      continue;
    }
    const rel = parsed.value;
    const cls = classifyFile(rel, config);
    if (cls === null) {
      if (verbosity === 'verbose') stderr.write(`ti: skipped (unsupported) ${rel}\n`);
      continue;
    }
    yield {
      path: rel,
      language: cls.language,
      vendor: matchesAny(rel, config.vendor),
      framework: cls.framework,
      frameworkClass: cls.frameworkClass,
    };
  }
}

function mayHavePhp(opts: BuildOptions): boolean {
  if (opts.onlyPaths !== undefined) {
    return opts.onlyPaths.some((p) => p.endsWith('.php'));
  }
  return true;
}

function resolveRepoRoot(): string {
  const envOverride = process.env.TI_REPO_ROOT;
  if (envOverride && existsSync(join(envOverride, 'vendor-php/bin/ti-php-extract.php'))) {
    return envOverride;
  }
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, 'vendor-php/bin/ti-php-extract.php'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url may be unavailable in some bundlers; fall through.
  }
  return process.cwd();
}
