import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
} from '../store/writers.js';
import { walk } from '../discover/walk.js';
import { classifyFile } from '../discover/framework.js';
import { matchesAny } from '../discover/glob.js';
import { extractFile } from '../extract/index.js';
import { synthesizeCompilerOptions } from '../extract/ts/compiler.js';
import { startPhpWorker, hasPhpAvailable, type PhpWorker } from '../extract/php/spawn.js';
import { WP_PHP_PATTERNS } from '../extract/declarative/wp-php-patterns.js';
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

    try {
      const repoRoot = opts.repoRoot ?? resolveRepoRoot();
      if (mayHavePhp(opts) && hasPhpAvailable()) {
        const wRes = startPhpWorker({ repoRoot });
        if (wRes.kind === 'ok') {
          worker = wRes.value;
          await worker.registerPatterns(WP_PHP_PATTERNS);
        } else if (verbosity !== 'quiet') {
          opts.stderr.write(
            `ti: php worker unavailable (${wRes.error.message}) — PHP files will be skipped\n`,
          );
        }
      }

      const compilerOptions = synthesizeCompilerOptions(opts.projectRoot);
      const source = opts.onlyPaths !== undefined
        ? listFromPaths(opts.onlyPaths, opts.projectRoot, opts.config, opts.stderr, verbosity)
        : walk(opts.projectRoot, opts.config);

      for await (const file of source) {
        const text = await readFile(join(opts.projectRoot, file.path), 'utf8').catch(() => null);
        if (text === null) {
          if (verbosity === 'verbose') opts.stderr.write(`ti: skipped (read failed) ${file.path}\n`);
          continue;
        }
        const contentHash = createHash('sha1').update(text).digest('hex');
        const fileId = upsertFile(db, {
          path: file.path,
          language: file.language,
          contentHash,
          extractedAt: opts.clock.now(),
          isTest: file.framework !== null,
          framework: file.framework,
          frameworkClass: file.frameworkClass,
        });

        const r = await extractFile({
          projectRoot: opts.projectRoot,
          path: file.path,
          language: file.language,
          framework: file.framework,
          compilerOptions,
          patterns: [],
          ...(worker !== undefined ? { phpWorker: worker } : {}),
        });
        if (r.kind === 'err') {
          if (verbosity !== 'quiet') {
            opts.stderr.write(`ti: extract failed ${file.path}: ${r.error.message}\n`);
          }
          continue;
        }

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
          if (f.kind === 'test-def') {
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

      const stopList = new Set<string>(HOOK_STOP_LIST_BUILTINS);
      for (const h of opts.config.hooks.stopList.add) stopList.add(h);
      for (const h of opts.config.hooks.stopList.remove) stopList.delete(h);

      const deriveSummary = derive({
        db,
        clock: opts.clock,
        params: {
          maxDepth: opts.config.traversal.maxDepth,
          maxMillisPerTest: opts.config.traversal.maxMillisPerTest,
          threshold: opts.config.confidence.threshold,
          hookStopList: stopList,
        },
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
      close();
    }
  } finally {
    releaseLock(opts.projectRoot);
  }
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
