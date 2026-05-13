import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

export function synthesizeCompilerOptions(projectRoot: string): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  };

  const candidates = ['tsconfig.json', 'jsconfig.json'];
  for (const name of candidates) {
    const path = resolve(projectRoot, name);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = ts.parseConfigFileTextToJson(path, raw);
      if (parsed.error || !parsed.config) continue;
      const cfg = parsed.config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const co = cfg.compilerOptions;
      if (!co) continue;
      if (co.baseUrl) base.baseUrl = resolve(projectRoot, co.baseUrl);
      if (co.paths) {
        const paths: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(co.paths)) paths[k] = [...v];
        base.paths = paths;
      }
      break;
    } catch {
      continue;
    }
  }

  return base;
}
