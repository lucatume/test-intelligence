import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

function defaults(): ts.CompilerOptions {
  return {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  };
}

interface RawCompilerOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

interface ResolvedFromFile {
  // Absolute baseUrl, if specified.
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

// Read tsconfig at an absolute file path, recursively resolving `extends`.
// Returns merged baseUrl/paths or null if unreadable. Child compilerOptions
// override extended ones. baseUrl resolves against the file that declares
// it (per TypeScript spec). `seen` guards against extends cycles.
function readConfigFile(absPath: string, seen: Set<string>): ResolvedFromFile | null {
  if (seen.has(absPath)) return null;
  seen.add(absPath);
  if (!existsSync(absPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = ts.parseConfigFileTextToJson(absPath, raw);
  if (parsed.error || !parsed.config) return null;
  const cfg = parsed.config as { extends?: string | string[]; compilerOptions?: RawCompilerOptions };
  const dir = dirname(absPath);

  // Start with the extended config (TS allows extends to be a string or array).
  let merged: ResolvedFromFile = {};
  const extendsList = Array.isArray(cfg.extends)
    ? cfg.extends
    : typeof cfg.extends === 'string' ? [cfg.extends] : [];
  for (const ext of extendsList) {
    const target = resolveExtendsPath(dir, ext);
    if (target === null) continue;
    const parentResolved = readConfigFile(target, seen);
    if (parentResolved) merged = mergeResolved(merged, parentResolved);
  }

  // Overlay this file's own compilerOptions.
  const co = cfg.compilerOptions;
  if (co) {
    const own: ResolvedFromFile = {};
    if (co.baseUrl) own.baseUrl = resolve(dir, co.baseUrl);
    if (co.paths) own.paths = co.paths;
    merged = mergeResolved(merged, own);
  }
  return merged;
}

function mergeResolved(base: ResolvedFromFile, overlay: ResolvedFromFile): ResolvedFromFile {
  const out: ResolvedFromFile = {};
  if (overlay.baseUrl !== undefined) out.baseUrl = overlay.baseUrl;
  else if (base.baseUrl !== undefined) out.baseUrl = base.baseUrl;
  if (overlay.paths !== undefined) {
    out.paths = {};
    for (const [k, v] of Object.entries(overlay.paths)) out.paths[k] = [...v];
  } else if (base.paths !== undefined) {
    out.paths = {};
    for (const [k, v] of Object.entries(base.paths)) out.paths[k] = [...v];
  }
  return out;
}

// `extends` can be a relative path, an absolute path, or a bare package name
// (resolved against node_modules). For project-local extends we just resolve
// against the declaring file's directory; package-style extends would need
// node module resolution, deferred until a real case demands it.
function resolveExtendsPath(fromDir: string, ext: string): string | null {
  if (ext.startsWith('./') || ext.startsWith('../') || ext.startsWith('/')) {
    let cand = resolve(fromDir, ext);
    if (existsSync(cand)) return cand;
    if (!cand.endsWith('.json')) {
      cand = `${cand}.json`;
      if (existsSync(cand)) return cand;
    }
    return null;
  }
  // Bare specifier — TS resolves these via Node-style module resolution
  // (e.g. `@tsconfig/strictest/tsconfig.json`). Not commonly used in the
  // projects we target; skip for now.
  return null;
}

// Reads tsconfig.json or jsconfig.json from a specific directory and
// returns CompilerOptions merged onto defaults — or null if no config exists
// there. `baseUrl` resolves against the config's own directory (per the
// TypeScript spec), not the project root.
function readConfigAt(dir: string): ts.CompilerOptions | null {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const path = resolve(dir, name);
    if (!existsSync(path)) continue;
    const resolved = readConfigFile(path, new Set());
    if (resolved === null) continue;
    if (resolved.baseUrl === undefined && resolved.paths === undefined) continue;
    const out = defaults();
    if (resolved.baseUrl !== undefined) out.baseUrl = resolved.baseUrl;
    if (resolved.paths !== undefined) out.paths = resolved.paths;
    return out;
  }
  return null;
}

export function synthesizeCompilerOptions(projectRoot: string): ts.CompilerOptions {
  return readConfigAt(projectRoot) ?? defaults();
}

// Per-file resolver: walks up from the file's directory to projectRoot
// looking for the nearest tsconfig.json / jsconfig.json. Results are cached
// by directory so adjacent files share work. Critical for monorepos where
// path aliases (e.g. `~/*`, `@woocommerce/*`) are declared in nested
// tsconfigs — a single root-only options object misses thousands of imports.
export class CompilerOptionsResolver {
  private readonly cache = new Map<string, ts.CompilerOptions>();
  private readonly rootFallback: ts.CompilerOptions;

  constructor(private readonly projectRoot: string) {
    this.rootFallback = synthesizeCompilerOptions(projectRoot);
  }

  forFile(absFile: string): ts.CompilerOptions {
    return this.forDir(dirname(absFile));
  }

  private forDir(dir: string): ts.CompilerOptions {
    const cached = this.cache.get(dir);
    if (cached) return cached;

    const config = readConfigAt(dir);
    let resolvedOptions: ts.CompilerOptions;
    if (config) {
      resolvedOptions = config;
    } else if (dir === this.projectRoot || !isInside(dir, this.projectRoot)) {
      resolvedOptions = this.rootFallback;
    } else {
      resolvedOptions = this.forDir(dirname(dir));
    }
    this.cache.set(dir, resolvedOptions);
    return resolvedOptions;
  }
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const sep = parent.endsWith('/') ? '' : '/';
  return child.startsWith(parent + sep);
}
