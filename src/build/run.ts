import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { acquireLock, releaseLock } from '../store/lock.js';
import { openStore } from '../store/open.js';
import {
  upsertFile,
  insertFact,
  upsertAnchor,
  insertFactAnchor,
  insertTest,
  clearFactsForFile,
  readFileExtractState,
  upsertWrapperIndexEntry,
  insertWrapperCallSite,
} from '../store/writers.js';
import { walk } from '../discover/walk.js';
import { classifyFile } from '../discover/framework.js';
import { matchesAny } from '../discover/glob.js';
import { extractFile } from '../extract/index.js';
import { CompilerOptionsResolver } from '../extract/ts/compiler.js';
import { hasPhpAvailable, type PhpWorker } from '../extract/php/spawn.js';
import { startPhpWorkerPool } from '../extract/php/pool.js';
import { flushDeferredPhpFacts } from '../extract/php/extract.js';
import { WP_PHP_PATTERNS } from '../extract/declarative/wp-php-patterns.js';
import { parseProjectRelativePath } from '../paths.js';
import { parseAnchor } from '../anchors/parse.js';
import { derive } from '../derive/derive.js';
import { resolveRestEndpoints } from './resolve-rest-endpoints.js';
import { resolveEnqueueScripts } from './resolve-enqueue-scripts.js';
import { resolveBlockJson } from './resolve-block-json.js';
import { runJsResolve } from '../jsresolve/index.js';
import { HOOK_STOP_LIST_BUILTINS, type ValidatedConfig } from '../config/parse.js';
import type { BuildOptions, BuildSummary, BuildError, BuildTimings, SlowFile } from './types.js';
import type { DiscoveredFile } from '../discover/types.js';
import { contentHash } from './contentHash.js';

// Files per BEGIN/COMMIT in the extract write loop. The store is opened in
// WAL mode, so without batching every per-file statement (upsertFile,
// clearFactsForFile DELETE, insertFact, …) is its own transaction with its
// own fsync — a re-build over a populated store pays one fsync per delete.
// Grouping ~500 files per COMMIT makes each file's DELETE ride the same
// fsync as its inserts. Matches the design spec's "chunks of 500 files".
const EXTRACT_BATCH_SIZE = 500;

export async function runBuild(opts: BuildOptions): Promise<Result<BuildSummary, BuildError>> {
  const startMs = opts.clock.nowMillis();
  const verbosity = opts.verbosity ?? 'normal';
  const topN = Math.max(0, opts.timing?.topN ?? 0);
  const emitTiming = opts.timing?.emit === true;
  const slowest = new SlowestTracker(topN);
  let extractTsMs = 0;
  let extractPhpMs = 0;
  let extractTsFiles = 0;
  let extractPhpFiles = 0;

  const lockStart = opts.clock.nowMillis();
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
  const lockMs = opts.clock.nowMillis() - lockStart;

  try {

    let filesExtracted = 0;
    let filesSkipped = 0;
    let factsInserted = 0;
    let testsFound = 0;
    let worker: PhpWorker | undefined;
    // Synthesized facts emitted during per-file extraction: (factId, wrapperName).
    // After flush-deferred the wrapper_index snapshot arrives; we then insert
    // wrapper_call_site rows for these and for the deferred facts.
    const pendingCallSites: Array<{ factId: number; wrapperName: string }> = [];

    try {
      const setupStart = opts.clock.nowMillis();
      const repoRoot = opts.repoRoot ?? resolveRepoRoot();
      const wpPatternWrappers = opts.config.wpPatternWrappers;
      const compilerOptionsResolver = new CompilerOptionsResolver(opts.projectRoot);

      // When updating a subset of paths, expand the set to include any caller
      // file that holds a synthesized fact backed by a wrapper whose def_file
      // is among the updated paths. Without this, the old synthesized facts for
      // those callers persist even after the wrapper definition changes.
      const effectiveOnlyPaths = opts.onlyPaths !== undefined
        ? expandOnlyPathsForWrapperUpdates(db, opts.onlyPaths)
        : undefined;
      // Drop old wrapper_index rows for the def files being re-extracted.
      // CASCADE deletes wrapper_call_site rows for the old synthesized facts.
      // Use the ORIGINAL onlyPaths (not expanded) — only actual def files lose
      // their index rows; the expanded caller files just get re-extracted.
      if (opts.onlyPaths !== undefined && opts.onlyPaths.length > 0) {
        const defPlaceholders = opts.onlyPaths.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM wrapper_index WHERE def_file IN (${defPlaceholders})`
        ).run(...opts.onlyPaths);
      }

      // Resolve the PHP worker pool size. For a subset update the .php file
      // count is known up front, so the pool scales down (see resolvePhpWorkers).
      // A full build's streaming walk has no cheap upfront count — base is used.
      const phpFileCountHint = effectiveOnlyPaths !== undefined
        ? effectiveOnlyPaths.filter((p) => p.endsWith('.php')).length
        : undefined;
      const phpWorkers = resolvePhpWorkers({
        configured: opts.config.concurrency.phpWorkers,
        cpuCount: cpus().length,
        phpFileCount: phpFileCountHint,
      });
      if (mayHavePhp(opts) && hasPhpAvailable()) {
        const wRes = startPhpWorkerPool({ repoRoot, size: phpWorkers, wpPatternWrappers });
        if (wRes.kind === 'ok') {
          worker = wRes.value;
          await worker.registerPatterns(WP_PHP_PATTERNS);
        } else if (verbosity !== 'quiet') {
          opts.stderr.write(
            `ti: php worker unavailable (${wRes.error.message}) — PHP files will be skipped\n`,
          );
        }
      }
      const setupMs = opts.clock.nowMillis() - setupStart;
      const extractPhaseStart = opts.clock.nowMillis();

      const source = effectiveOnlyPaths !== undefined
        ? listFromPaths(effectiveOnlyPaths, opts.projectRoot, opts.config, opts.stderr, verbosity)
        : walk(opts.projectRoot, opts.config);
      const it = toAsyncIterator(source);

      // Batched writes: open one BEGIN, COMMIT every EXTRACT_BATCH_SIZE files,
      // final COMMIT after the lanes drain. Raw BEGIN/COMMIT (not
      // db.transaction) because lanes await between files; mirrors derive.ts.
      // Lanes interleave only at `await` points, never inside a file's
      // synchronous write block, so `filesSinceCommit` is race-free.
      let filesSinceCommit = 0;
      db.exec('BEGIN');
      let extractCommitted = false;

      // Lane count tracks pool size: each lane awaits a PHP extract on one
      // slot, but ties up no slot during file read / TS extract. SQLite writes
      // are synchronous and so naturally serialize between the lanes' awaits.
      const laneCount = phpWorkers;
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
            const hash = contentHash(text);
            // Incremental skip: a file whose content hash matches the stored
            // hash and that already has facts did not change — leave its
            // facts/anchors/test rows untouched and do no extraction. A
            // hash-matched file with zero facts (failed/partial prior
            // extraction) still re-extracts. Deterministic: no clock read.
            if (opts.skipUnchanged === true) {
              const state = readFileExtractState(db, file.path);
              if (state !== null && state.contentHash === hash && state.factCount > 0) {
                filesSkipped++;
                if (verbosity === 'verbose') {
                  opts.stderr.write(`ti: skipped (unchanged) ${file.path}\n`);
                }
                continue;
              }
            }
            const compilerOptions = compilerOptionsResolver.forFile(
              join(opts.projectRoot, file.path),
            );
            const extractStart = opts.clock.nowMillis();
            const r = await extractFile({
              projectRoot: opts.projectRoot,
              path: file.path,
              language: file.language,
              framework: file.framework,
              compilerOptions,
              patterns: [],
              ...(worker !== undefined ? { phpWorker: worker } : {}),
            });
            const extractElapsed = opts.clock.nowMillis() - extractStart;
            if (file.language === 'php') {
              extractPhpMs += extractElapsed;
              extractPhpFiles++;
            } else {
              extractTsMs += extractElapsed;
              extractTsFiles++;
            }
            if (topN > 0) slowest.consider({ path: file.path, language: file.language, millis: extractElapsed });
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
              contentHash: hash,
              extractedAt: opts.clock.now(),
              isTest: file.framework !== null,
              framework: file.framework,
              frameworkClass: file.frameworkClass,
            });
            // Per-file delete-then-insert: drop this file's prior facts so a
            // re-build (cold start or `ti update`) replaces facts instead of
            // appending. fact_anchor cascades; anchors are keyed and shared.
            clearFactsForFile(db, fileId);
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
              // Track synthesized wrapper facts for wrapper_call_site insertion
              // after the flush-deferred snapshot arrives.
              const meta = (f.payload as unknown as Record<string, unknown>)['meta'];
              if (
                meta !== null && typeof meta === 'object' &&
                (meta as Record<string, unknown>)['resolvedBy'] === 'wrapper-auto' &&
                typeof (meta as Record<string, unknown>)['wrapperName'] === 'string'
              ) {
                pendingCallSites.push({
                  factId,
                  wrapperName: (meta as Record<string, unknown>)['wrapperName'] as string,
                });
              }
            }
            if (verbosity === 'verbose') {
              opts.stderr.write(`ti: extracted ${file.path} (${String(r.value.length)} facts)\n`);
            }
            // Rotate the batch transaction. Safe here: this runs inside the
            // synchronous write block, so no other lane can interleave.
            filesSinceCommit++;
            if (filesSinceCommit >= EXTRACT_BATCH_SIZE) {
              db.exec('COMMIT');
              db.exec('BEGIN');
              filesSinceCommit = 0;
            }
          }
        })());
      }
      try {
        await Promise.all(lanes);
        // Flush any cross-file deferred wrapper calls that couldn't be resolved
        // during per-file extraction (caller processed before wrapper-def file).
        if (worker !== undefined) {
          // Barrier: each worker built only a partial wrapper index — it saw
          // only its share of files. Gather every worker's auto entries,
          // broadcast the union back, so each worker's flush-deferred replay
          // resolves wrappers defined on a different worker. For a size-1 pool
          // this is a harmless self round-trip.
          const globalWrapperIndex = await worker.dumpWrapperIndex();
          await worker.mergeWrapperIndex(globalWrapperIndex);
          const flushResult = await flushDeferredPhpFacts({
            projectRoot: opts.projectRoot,
            worker,
          });
          // Collect deferred fact ids with their wrapperName for call_site linking.
          const deferredCallSites: Array<{ factId: number; wrapperName: string }> = [];
          for (const f of flushResult.facts) {
            // Locate the existing file row — the caller file was already extracted
            // in the lane loop above. Fall back to upsert only if somehow absent.
            let fileId: number;
            const existing = readFileExtractState(db, f.location.file);
            if (existing !== null) {
              fileId = existing.fileId;
            } else {
              fileId = upsertFile(db, {
                path: f.location.file,
                language: 'php',
                contentHash: '',
                extractedAt: opts.clock.now(),
                isTest: false,
                framework: null,
                frameworkClass: null,
              });
            }
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
            const meta = (f.payload as unknown as Record<string, unknown>)['meta'];
            if (
              meta !== null && typeof meta === 'object' &&
              (meta as Record<string, unknown>)['resolvedBy'] === 'wrapper-auto' &&
              typeof (meta as Record<string, unknown>)['wrapperName'] === 'string'
            ) {
              deferredCallSites.push({
                factId,
                wrapperName: (meta as Record<string, unknown>)['wrapperName'] as string,
              });
            }
          }
          // Persist wrapper_index rows and link call sites.
          const wrapperIdByName = new Map<string, number>();
          for (const entry of flushResult.wrapperIndex) {
            const wrapperId = upsertWrapperIndexEntry(db, {
              wrapperName: entry.wrapperName,
              wraps: entry.wraps,
              defFile: entry.defFile,
              defStartLine: entry.defStartLine,
              defEndLine: entry.defEndLine,
              argSpecsJson: entry.argSpecsJson,
              source: entry.source,
            });
            wrapperIdByName.set(entry.wrapperName, wrapperId);
          }
          for (const cs of [...pendingCallSites, ...deferredCallSites]) {
            const wrapperId = wrapperIdByName.get(cs.wrapperName);
            if (wrapperId !== undefined) {
              insertWrapperCallSite(db, { factId: cs.factId, wrapperId });
            }
          }
        }
        db.exec('COMMIT');
        extractCommitted = true;
      } finally {
        if (!extractCommitted) {
          try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        }
      }
      const extractPhaseMs = opts.clock.nowMillis() - extractPhaseStart;

      // Cross-file pass: fill rest-endpoint facts whose namespace is an
      // inherited class property, and re-point enqueue-script js-module
      // anchors that name a compiled bundle to their source entry. Must run
      // after every file's facts are in the store and before derive snapshots
      // the graph.
      db.exec('BEGIN');
      try {
        resolveRestEndpoints(db);
        resolveEnqueueScripts(db, {
          outputDirs: opts.config.build.outputDirs,
          projectRoot: opts.projectRoot,
        });
        resolveBlockJson(db, { projectRoot: opts.projectRoot });
        runJsResolve(db, { projectRoot: opts.projectRoot });
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw e;
      }

      const stopList = new Set<string>(HOOK_STOP_LIST_BUILTINS);
      for (const h of opts.config.hooks.stopList.add) stopList.add(h);
      for (const h of opts.config.hooks.stopList.remove) stopList.delete(h);

      const derivePhaseStart = opts.clock.nowMillis();
      const deriveSummary = await derive({
        db,
        clock: opts.clock,
        params: {
          maxDepth: opts.config.traversal.maxDepth,
          maxMillisPerTest: opts.config.traversal.maxMillisPerTest,
          threshold: opts.config.confidence.threshold,
          hookStopList: stopList,
          maxWildcardMatchesPerAnchor: opts.config.traversal.maxWildcardMatchesPerAnchor,
        },
        workers: resolveDeriveWorkers(opts.config.concurrency.deriveWorkers),
      });
      const derivePhaseMs = opts.clock.nowMillis() - derivePhaseStart;

      const evidenceCount = (
        db.prepare('SELECT COUNT(*) AS n FROM edge, json_each(edge.evidence)').get() as { n: number }
      ).n;

      const elapsedMillis = opts.clock.nowMillis() - startMs;
      const timings: BuildTimings = {
        lockMs,
        setupMs,
        extractPhaseMs,
        extractTsMs,
        extractPhpMs,
        extractTsFiles,
        extractPhpFiles,
        derivePhaseMs,
        deriveLoadGraphMs: deriveSummary.timings.loadGraphMs,
        deriveBuildIndexMs: deriveSummary.timings.buildIndexMs,
        deriveTraverseMs: deriveSummary.timings.traverseMs,
        deriveWriteMs: deriveSummary.timings.writeMs,
        totalMs: elapsedMillis,
        slowestFiles: slowest.snapshot(),
      };
      const summary: BuildSummary = {
        filesExtracted,
        filesSkipped,
        factsInserted,
        testsFound,
        edgesWritten: deriveSummary.edgesWritten,
        evidenceCount,
        testsBounded: deriveSummary.testsBounded,
        elapsedMillis,
        timings,
      };
      if (verbosity !== 'quiet') {
        opts.stderr.write(
          `ti: build complete — ${String(filesExtracted)} files` +
          (filesSkipped > 0 ? `, ${String(filesSkipped)} skipped` : '') +
          `, ${String(factsInserted)} facts, ` +
          `${String(testsFound)} tests, ${String(deriveSummary.edgesWritten)} edges, ` +
          `${String(evidenceCount)} evidence` +
          (deriveSummary.testsBounded > 0 ? ` (${String(deriveSummary.testsBounded)} bounded)` : '') +
          ` in ${String(elapsedMillis)}ms\n`,
        );
        if (emitTiming) {
          opts.stderr.write(formatTimings(timings));
        }
      }
      return ok(summary);
    } finally {
      if (worker) await worker.shutdown();
      close();
    }
  } finally {
    releaseLock(opts.projectRoot);
  }
}

// Bounded "top N by millis" — small enough that a linear scan beats a heap.
// Empty when capacity is 0, which is the default (collection opt-in).
class SlowestTracker {
  private readonly capacity: number;
  private readonly items: SlowFile[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  consider(item: SlowFile): void {
    if (this.capacity <= 0) return;
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    // Find the current minimum slot; replace it if the new item is slower.
    let minIdx = 0;
    let minMs = this.items[0]?.millis ?? 0;
    for (let i = 1; i < this.items.length; i++) {
      const m = this.items[i]?.millis ?? 0;
      if (m < minMs) {
        minMs = m;
        minIdx = i;
      }
    }
    if (item.millis > minMs) this.items[minIdx] = item;
  }

  snapshot(): readonly SlowFile[] {
    return [...this.items].sort((a, b) => b.millis - a.millis);
  }
}

function formatTimings(t: BuildTimings): string {
  let out = `ti: timings — lock ${String(t.lockMs)}ms, setup ${String(t.setupMs)}ms, ` +
    `extract ${String(t.extractPhaseMs)}ms ` +
    `(ts ${String(t.extractTsMs)}ms/${String(t.extractTsFiles)} files, ` +
    `php ${String(t.extractPhpMs)}ms/${String(t.extractPhpFiles)} files), ` +
    `derive ${String(t.derivePhaseMs)}ms ` +
    `(loadGraph ${String(t.deriveLoadGraphMs)}ms, ` +
    `buildIndex ${String(t.deriveBuildIndexMs)}ms, ` +
    `traverse ${String(t.deriveTraverseMs)}ms, ` +
    `write ${String(t.deriveWriteMs)}ms), ` +
    `total ${String(t.totalMs)}ms\n`;
  if (t.slowestFiles.length > 0) {
    out += `ti: slowest extracts (top ${String(t.slowestFiles.length)}):\n`;
    for (const f of t.slowestFiles) {
      out += `  ${f.path}\t${f.language}\t${String(f.millis)}ms\n`;
    }
  }
  return out;
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

// One PHP worker handles roughly this many files before a second worker pays
// for its ~512M process and startup cost. Used only to scale down small
// subset updates; full builds always use the resolved base count.
const PHP_FILES_PER_WORKER = 32;

// Resolve the PHP worker pool size.
// - configured: concurrency.phpWorkers from config (clamped to >= 1 — PHP
//   always needs a subprocess, so 0 is meaningless and treated as 1).
// - cpuCount: os.cpus().length, injected for testability.
// - phpFileCount: number of .php files when known up front (subset updates);
//   undefined for a full build's streaming walk. When known, the pool scales
//   down so a few-file `ti update` does not spawn the whole pool.
export function resolvePhpWorkers(opts: {
  configured: number | undefined;
  cpuCount: number;
  phpFileCount?: number | undefined;
}): number {
  const base = opts.configured !== undefined
    ? Math.max(1, Math.floor(opts.configured))
    : Math.min(Math.max(opts.cpuCount - 2, 1), 8);
  if (opts.phpFileCount === undefined) return base;
  const scaled = Math.max(1, Math.ceil(opts.phpFileCount / PHP_FILES_PER_WORKER));
  return Math.min(base, scaled);
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

// When onlyPaths targets a wrapper def file, expand the update set to include
// every caller file that has a synthesized fact backed by that wrapper.
// Returns a new array that is the union of onlyPaths plus any discovered caller paths.
function expandOnlyPathsForWrapperUpdates(
  db: Database.Database,
  onlyPaths: ReadonlyArray<string>,
): string[] {
  const set = new Set(onlyPaths);
  if (set.size === 0) return [...set];
  const placeholders = [...set].map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT fl.path
    FROM wrapper_call_site wcs
    JOIN wrapper_index wi ON wi.id = wcs.wrapper_id
    JOIN fact f ON f.id = wcs.fact_id
    JOIN file fl ON fl.id = f.file_id
    WHERE wi.def_file IN (${placeholders})
  `).all(...set) as Array<{ path: string }>;
  for (const r of rows) set.add(r.path);
  return [...set];
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
