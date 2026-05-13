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

// Reads tsconfig.json or jsconfig.json from a specific directory and
// returns CompilerOptions merged onto defaults — or null if no config exists
// there. `baseUrl` resolves against the config's own directory (per the
// TypeScript spec), not the project root.
function readConfigAt(dir: string): ts.CompilerOptions | null {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const path = resolve(dir, name);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = ts.parseConfigFileTextToJson(path, raw);
      if (parsed.error || !parsed.config) continue;
      const cfg = parsed.config as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const co = cfg.compilerOptions;
      if (!co) continue;
      const out = defaults();
      if (co.baseUrl) out.baseUrl = resolve(dir, co.baseUrl);
      if (co.paths) {
        const paths: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(co.paths)) paths[k] = [...v];
        out.paths = paths;
      }
      return out;
    } catch {
      // fall through to the next candidate
    }
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
