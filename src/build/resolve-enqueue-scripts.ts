// Cross-file resolver for enqueue-script facts whose js-module anchor names a
// COMPILED artifact rather than a hand-written source file. Runs after every
// file's facts are in the store and before derive snapshots the graph — same
// position and transaction contract as resolveRestEndpoints.
//
// Resolution order (spec Change 2): universal artifacts first, WP-specific last.
//   1. .min.js -> .js
//   2. <path>.map source map naming an extant project source
//   3. build/<name>.js + <name>.asset.php sibling -> src/<name>.{tsx,ts,js}/index.*
// A js-module path that already names an extant file is left untouched (the
// classic-WP case). An unresolvable compiled path is left as-is.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import type Database from 'better-sqlite3';
import { repointFactAnchor, upsertAnchor } from '../store/writers.js';

const JS_EXTS = ['.tsx', '.ts', '.jsx', '.mjs', '.cjs', '.js'];
const ANCHOR_PREFIX = 'js-module:';

export interface ResolveEnqueueOptions {
  readonly outputDirs: readonly string[];
  /** Absolute project root, used to read source-map files from disk. When
   *  omitted the source-map step is skipped (store-only resolution). */
  readonly projectRoot?: string;
}

export interface ResolveEnqueueSummary {
  /** js-module anchors examined as possibly-compiled. */
  readonly examined: number;
  /** anchors re-pointed to a source file. */
  readonly repointed: number;
  /** enqueue-script facts gaining a js-module anchor via src-skeleton suffix
   *  resolution (the WC()->plugin_url() . '/path' . $suffix idiom). */
  readonly skeletonResolved: number;
}

interface FactAnchorRow {
  readonly factId: number;
  readonly anchorId: number;
  readonly key: string;
}

interface FactSrcRow {
  readonly factId: number;
  readonly payload: string;
}

// Resolve every compiled js-module anchor on an enqueue-script fact. Mutates
// fact_anchor rows in place. Caller owns the transaction.
export function resolveEnqueueScripts(
  db: Database.Database,
  opts: ResolveEnqueueOptions,
): ResolveEnqueueSummary {
  // Set of every project-relative file path in the store, for O(1) existence.
  const filePaths = new Set<string>();
  for (const r of db.prepare(`SELECT path FROM file`).all() as { path: string }[]) {
    filePaths.add(r.path);
  }

  const rows = db.prepare(
    `SELECT fa.fact_id AS factId, fa.anchor_id AS anchorId, a.key AS key
     FROM fact f
     JOIN fact_anchor fa ON fa.fact_id = f.id AND fa.role = 'target'
     JOIN anchor a ON a.id = fa.anchor_id AND a.type = 'js-module'
     WHERE f.kind = 'enqueue-script'`,
  ).all() as FactAnchorRow[];

  let examined = 0;
  let repointed = 0;
  for (const row of rows) {
    const path = row.key.startsWith(ANCHOR_PREFIX)
      ? row.key.slice(ANCHOR_PREFIX.length)
      : row.key;
    // A path that looks like a compiled artifact (a `.min.js` bundle, or a
    // file under a build-output directory) is always a remap candidate even
    // when the bundle itself is an extant file row — tests test the source,
    // not the bundle. Any other extant path is hand-written source: leave it
    // (classic-WP case).
    if (filePaths.has(path) && !looksCompiled(path, opts.outputDirs)) continue;
    examined++;
    const resolved = resolveCompiled(path, filePaths, opts);
    if (resolved === null || resolved === path) continue;
    const newAnchorId = upsertAnchor(db, { key: ANCHOR_PREFIX + resolved, type: 'js-module' });
    repointFactAnchor(db, {
      factId: row.factId,
      oldAnchorId: row.anchorId,
      newAnchorId,
      role: 'target',
    });
    repointed++;
  }

  const skeletonResolved = resolveSrcSkeletons(db, filePaths);
  return { examined, repointed, skeletonResolved };
}

/**
 * Second pass: enqueue-script facts that the PHP worker could not give a
 * js-module anchor — the directory base was a method call or a variable
 * (`WC()->plugin_url() . '/assets/js/...' . $suffix . '.js'`). Their `src`
 * skeleton still carries the literal path TAIL. Strip the leading `{*}/` and a
 * single `{*}` before the extension (the `$suffix` .min token), then suffix-
 * match the clean tail against the store's file set. A unique JS match gets a
 * js-module anchor inserted; an ambiguous or absent match is left alone.
 */
function resolveSrcSkeletons(
  db: Database.Database,
  filePaths: ReadonlySet<string>,
): number {
  const filePathList = [...filePaths];
  // Facts that already carry a js-module anchor are done; the rest may have a
  // resolvable src skeleton.
  const withModule = new Set<number>(
    (db.prepare(
      `SELECT DISTINCT fa.fact_id AS factId FROM fact_anchor fa
       JOIN anchor a ON a.id = fa.anchor_id
       WHERE a.type = 'js-module' AND fa.role = 'target'`,
    ).all() as { factId: number }[]).map((r) => r.factId),
  );

  let resolved = 0;
  const rows = db.prepare(
    `SELECT id AS factId, payload FROM fact WHERE kind = 'enqueue-script'`,
  ).all() as FactSrcRow[];
  for (const row of rows) {
    if (withModule.has(row.factId)) continue;
    let payload: unknown;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    const src = (payload as { src?: unknown }).src;
    if (typeof src !== 'string' || src === '') continue;
    const tail = skeletonTail(src);
    if (tail === null) continue;
    const match = uniqueSuffixMatch(tail, filePathList);
    if (match === null) continue;
    const anchorId = upsertAnchor(db, { key: ANCHOR_PREFIX + match, type: 'js-module' });
    db.prepare(
      `INSERT OR IGNORE INTO fact_anchor (fact_id, anchor_id, role) VALUES (?, ?, 'target')`,
    ).run(row.factId, anchorId);
    resolved++;
  }
  return resolved;
}

/**
 * Reduce a `src` skeleton to a clean literal path tail, or null when it is not
 * a JS path with a usable literal tail. Drops a leading `{*}/` (the resolved
 * directory base) and a single `{*}` immediately before the `.js` extension
 * (the `$suffix` .min token). Any other `{*}` makes the tail unusable.
 */
export function skeletonTail(src: string): string | null {
  let s = src;
  // Drop a leading `{*}` directory base (with or without the following slash).
  if (s.startsWith('{*}/')) s = s.slice('{*}/'.length);
  else if (s.startsWith('{*}')) s = s.slice('{*}'.length);
  // A `$suffix` token directly before `.js` — collapse `{*}.js` to `.js`.
  s = s.replace(/\{\*\}(\.m?js)$/i, '$1');
  if (s.includes('{*}')) return null;
  if (!/\.(mjs|cjs|jsx|tsx|ts|js)$/i.test(s)) return null;
  return s.replace(/^\/+/, '');
}

/**
 * Find the one file path that ends with `/<tail>` (or equals `tail`). When the
 * tail is a `.min.js` form, a non-minified sibling is preferred. Returns null
 * when zero or more than one file matches — never guesses.
 */
function uniqueSuffixMatch(tail: string, filePaths: readonly string[]): string | null {
  const want = '/' + tail;
  const matches = filePaths.filter((p) => p === tail || p.endsWith(want));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  return null;
}

/** A path that names a compiled artifact: a `.min.js` bundle, or a file under
 *  a configured build-output directory. */
function looksCompiled(path: string, outputDirs: readonly string[]): boolean {
  if (path.endsWith('.min.js')) return true;
  return path.split('/').some((s) => outputDirs.includes(s));
}

/** Try the three resolvers in order; return a project-relative source path or null. */
function resolveCompiled(
  path: string,
  filePaths: ReadonlySet<string>,
  opts: ResolveEnqueueOptions,
): string | null {
  // 1. .min.js -> .js (universal).
  if (path.endsWith('.min.js')) {
    const unmin = path.slice(0, -'.min.js'.length) + '.js';
    if (filePaths.has(unmin)) return unmin;
  }

  // 2. Source map (universal). Read <path>.map from disk if a root is given.
  if (opts.projectRoot !== undefined) {
    const mapAbs = join(opts.projectRoot, path + '.map');
    if (existsSync(mapAbs)) {
      const src = firstMappedSource(mapAbs, path, filePaths);
      if (src !== null) return src;
    }
  }

  // 3. *.asset.php manifest (WP-specific) — only under a build-output dir.
  const segments = path.split('/');
  const inOutputDir = segments.some((s) => opts.outputDirs.includes(s));
  if (inOutputDir && extname(path) === '.js') {
    const assetSibling = path.slice(0, -'.js'.length) + '.asset.php';
    if (filePaths.has(assetSibling)) {
      const src = mapBuildToSrc(path, opts.outputDirs, filePaths);
      if (src !== null) return src;
    }
  }
  return null;
}

/** Resolve the first `sources` entry of a source map to an extant project file. */
function firstMappedSource(
  mapAbs: string,
  bundlePath: string,
  filePaths: ReadonlySet<string>,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mapAbs, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const sources = (parsed as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return null;
  const bundleDir = dirname(bundlePath);
  for (const s of sources) {
    if (typeof s !== 'string') continue;
    const clean = s.replace(/^webpack:\/\/\/?/, '');
    // Source-map `sources` are relative to the bundle's directory.
    const candidate = normalizeRel(join(bundleDir, clean));
    if (filePaths.has(candidate)) return candidate;
  }
  return null;
}

/** Map build/<name>.js -> src/<name>.{ext} or src/<name>/index.{ext}. */
function mapBuildToSrc(
  bundlePath: string,
  outputDirs: readonly string[],
  filePaths: ReadonlySet<string>,
): string | null {
  const segments = bundlePath.split('/');
  const idx = segments.findIndex((s) => outputDirs.includes(s));
  if (idx < 0) return null;
  const tail = segments.slice(idx + 1).join('/'); // e.g. index.js
  const stem = tail.slice(0, tail.length - extname(tail).length); // index
  const srcRoot = [...segments.slice(0, idx), 'src'].join('/').replace(/^\//, '');
  for (const ext of JS_EXTS) {
    const prefix = srcRoot === '' ? stem : srcRoot + '/' + stem;
    const direct = prefix + ext;
    if (filePaths.has(direct)) return direct;
    const indexed = prefix + '/index' + ext;
    if (filePaths.has(indexed)) return indexed;
  }
  return null;
}

/** Collapse ./ and ../ in a POSIX-ish relative path. */
function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}
