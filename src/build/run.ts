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
  upsertWrapperIndexEntry,
  insertWrapperCallSite,
} from '../store/writers.js';
import { walk } from '../discover/walk.js';
import { extractFile } from '../extract/index.js';
import { CompilerOptionsResolver } from '../extract/ts/compiler.js';
import { hasPhpAvailable, type PhpWorker } from '../extract/php/spawn.js';
import { startPhpWorkerPool } from '../extract/php/pool.js';
import { flushDeferredPhpFacts } from '../extract/php/extract.js';
import { WP_PHP_PATTERNS } from '../extract/declarative/wp-php-patterns.js';
import { parseAnchor } from '../anchors/parse.js';
import { derive } from '../derive/derive.js';
import { resolveRestEndpoints } from './resolve-rest-endpoints.js';
import { resolveEnqueueScripts } from './resolve-enqueue-scripts.js';
import { resolveBlockJson } from './resolve-block-json.js';
import { runJsResolve } from '../jsresolve/index.js';
import { emitCoreAdminEntryPointFacts } from '../extract/php/wp-bootstrap.js';
import { HOOK_STOP_LIST_BUILTINS } from '../config/parse.js';
import type { BuildOptions, BuildSummary, BuildError, BuildTimings, SlowFile } from './types.js';
import type { DiscoveredFile } from '../discover/types.js';
import { contentHash } from './contentHash.js';

// Files per transaction in the extract write loop. Batching keeps the
// JS/native call overhead bounded without holding one transaction for the
// entire repository.
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

  let db: Database.Database;
  let close = (): void => {};
  let locked = false;
  if (opts.db !== undefined) {
    db = opts.db;
  } else {
    const sRes = openStore(opts.projectRoot);
    if (sRes.kind === 'err') return err({ kind: 'BuildError', message: sRes.error.message });
    db = sRes.value.db;
    close = sRes.value.close;

    const lockRes = acquireLock(opts.projectRoot, {
      command: 'build',
      clock: opts.clock,
    });
    if (lockRes.kind === 'err') {
      close();
      return err({ kind: 'BuildError', message: `lock: ${lockRes.error.kind}` });
    }
    locked = true;
  }
  try {

    let filesExtracted = 0;
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

      const phpWorkers = resolvePhpWorkers({
        configured: opts.config.concurrency.phpWorkers,
        cpuCount: cpus().length,
      });
      if (hasPhpAvailable()) {
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

      // Two-phase needs the full file list before phase 2 starts, so we
      // materialize once. Memory is trivial (DiscoveredFile is ~6 fields,
      // even 34k files fit comfortably).
      const discoveredFiles: DiscoveredFile[] = [];
      for await (const file of walk(opts.projectRoot, opts.config)) {
        discoveredFiles.push(file);
      }

      // Two-phase build applies to full builds with a PHP worker.
      //
      // Phase 1: every worker parses every PHP file and runs buildWrapperIndex
      // only — no facts. Barrier: dump/merge so every worker holds the
      // complete index. Phase 2: the existing extract loop, with
      // wrapperIndexComplete=true so wrapper calls always resolve via the
      // live path (no per-worker partial knowledge, no denylist gate
      // dropping legitimate wrappers).
      //
      const useTwoPhase = worker !== undefined;

      // The `worker !== undefined` check is already in useTwoPhase, but TS
      // control-flow narrowing does not carry through the boolean. Re-check
      // here so the binding below is typed as `PhpWorker`, not `PhpWorker | undefined`.
      if (useTwoPhase && worker !== undefined) {
        const twoPhaseWorker = worker;
        const phpFiles = discoveredFiles.filter((f) => f.language === 'php');
        let nextPrepassIdx = 0;
        const prepassLanes: Promise<void>[] = [];
        for (let i = 0; i < phpWorkers; i++) {
          prepassLanes.push((async (): Promise<void> => {
            for (;;) {
              const idx = nextPrepassIdx++;
              if (idx >= phpFiles.length) return;
              const file = phpFiles[idx];
              if (file === undefined) return;
              try {
                await twoPhaseWorker.prepass(join(opts.projectRoot, file.path), file.path);
              } catch (e) {
                if (verbosity !== 'quiet') {
                  opts.stderr.write(`ti: prepass failed ${file.path}: ${(e as Error).message}\n`);
                }
              }
            }
          })());
        }
        await Promise.all(prepassLanes);
        // If every pool slot died during phase-1 (catastrophic PHP subprocess
        // failure), the lanes will have swallowed N rejections into stderr
        // and we'd start phase-2 with an empty wrapper index plus every
        // extract call immediately throwing. Detect once at the barrier and
        // bail loud.
        const aliveAfterPrepass = await twoPhaseWorker.ping().catch(() => false);
        if (!aliveAfterPrepass) {
          return err({ kind: 'BuildError', message: 'php workers died during phase-1 prepass' });
        }
        // Barrier: gather every worker's partial index, broadcast the union.
        const globalIndex = await twoPhaseWorker.dumpWrapperIndex();
        await twoPhaseWorker.mergeWrapperIndex(globalIndex);
      }

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
      let nextFileIdx = 0;
      for (let i = 0; i < laneCount; i++) {
        lanes.push((async (): Promise<void> => {
          for (;;) {
            const idx = nextFileIdx++;
            if (idx >= discoveredFiles.length) return;
            const file = discoveredFiles[idx];
            if (file === undefined) return;
            const text = await readFile(join(opts.projectRoot, file.path), 'utf8').catch(() => null);
            if (text === null) {
              if (verbosity === 'verbose') opts.stderr.write(`ti: skipped (read failed) ${file.path}\n`);
              continue;
            }
            const hash = contentHash(text);
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
              ...(useTwoPhase && file.language === 'php' ? { wrapperIndexComplete: true } : {}),
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
          // Every worker already holds the complete index post-phase-1. This
          // round-trip also supplies the snapshot persisted below.
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
            const existing = db.prepare('SELECT id FROM file WHERE path = ?')
              .get(f.location.file) as { id: number } | undefined;
            if (existing !== undefined) {
              fileId = existing.id;
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

        // Plan 05: emit synthetic admin-page-register facts for canonical
        // WordPress core entry-point files (wp-admin/edit.php, wp-login.php,
        // …). These are the join partners for JS-side `admin-page-nav` facts
        // produced by the `wp-frontend-or-admin-url` catalogue. Core files are
        // not registered via add_menu_page so the static extractor never emits
        // anchors for them; this fills the gap. Idempotent: each file row is
        // upserted and its facts replaced.
        const bootstrapFacts = await emitCoreAdminEntryPointFacts({ projectRoot: opts.projectRoot });
        for (const f of bootstrapFacts) {
          const fileId = upsertFile(db, {
            path: f.relativePath,
            language: 'php',
            contentHash: '',
            extractedAt: opts.clock.now(),
            isTest: false,
            framework: null,
            frameworkClass: null,
          });
          clearFactsForFile(db, fileId);
          const factId = insertFact(db, {
            fileId,
            kind: f.kind,
            resolved: f.resolved,
            startLine: f.startLine,
            endLine: f.endLine,
            payload: f.payload,
          });
          factsInserted++;
          for (const a of f.anchors) {
            const parsed = parseAnchor(a.key);
            if (parsed.kind === 'err') continue;
            const anchorId = upsertAnchor(db, { key: parsed.value.key, type: parsed.value.type });
            insertFactAnchor(db, { factId, anchorId, role: a.role });
          }
        }

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

      const edgesTotal = (db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n;
      const evidenceCount = (
        db.prepare('SELECT COUNT(*) AS n FROM edge, json_each(edge.evidence)').get() as { n: number }
      ).n;

      const elapsedMillis = opts.clock.nowMillis() - startMs;
      const timings: BuildTimings = {
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
          `, ${String(factsInserted)} facts, ` +
          `${String(testsFound)} tests, ${String(edgesTotal)} edges, ` +
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
    if (locked) releaseLock(opts.projectRoot);
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
  let out = `ti: timings — setup ${String(t.setupMs)}ms, ` +
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
