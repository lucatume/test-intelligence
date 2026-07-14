import { relative, sep } from 'node:path';
import ts from 'typescript';
import type { Fact, FactLocation, ImportEdgePayload } from '../../facts/types.js';
import type { AnchorKey } from '../../types.js';

// Node.js built-in modules. Specifiers in this set (or `node:`-prefixed) are
// real modules — just not project files — so they should not be counted as
// unresolved. Source: `module.builtinModules` snapshot for Node 20 / 22.
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix',
  'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'stream/consumers', 'stream/promises',
  'stream/web', 'string_decoder', 'sys', 'test', 'timers',
  'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util',
  'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  return NODE_BUILTINS.has(spec);
}

// Specifiers ending in a non-JS extension are bundler-handled assets
// (styles, JSON, fonts, images, WP block descriptors). They are real imports
// but never resolve to JS modules. Mark them resolved+asset so they stop
// inflating the unresolved bucket.
const ASSET_EXT_RE =
  /\.(?:scss|sass|css|less|stylus|styl|json|json5|yaml|yml|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|md|mdx|txt|html|wasm)$/i;

function isAssetSpecifier(spec: string): boolean {
  // Strip query/fragment that bundlers tolerate.
  const cleaned = spec.replace(/[?#].*$/, '');
  return ASSET_EXT_RE.test(cleaned);
}

interface SpecifierRef {
  readonly specifier: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly pos: number;
  readonly typeOnly: boolean;
}

export function extractImports(
  sf: ts.SourceFile,
  relPath: string,
  projectRoot: string,
  options: ts.CompilerOptions,
): Fact[] {
  const out: Fact[] = [];
  const host = ts.createCompilerHost(options, true);
  const seen = new Set<string>();

  collectSpecifiers(sf, (ref) => {
    const key = `${ref.specifier}@${String(ref.pos)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const builtin = isNodeBuiltin(ref.specifier);
    const asset = !builtin && isAssetSpecifier(ref.specifier);
    let resolvedRel: string | undefined;
    if (!builtin && !asset) {
      const resolved = ts.resolveModuleName(ref.specifier, sf.fileName, options, host);
      if (resolved.resolvedModule) {
        const abs = resolved.resolvedModule.resolvedFileName;
        const rel = toPosix(relative(projectRoot, abs));
        if (!rel.startsWith('..') && !rel.startsWith('/')) resolvedRel = rel;
      }
    }

    const isResolved = builtin || asset || resolvedRel !== undefined;
    const anchorBody = resolvedRel ?? ref.specifier;
    const metaFlags: Record<string, unknown> = {};
    if (builtin) metaFlags['builtin'] = true;
    if (asset) metaFlags['asset'] = true;
    if (ref.typeOnly) metaFlags['typeOnly'] = true;
    const payload: ImportEdgePayload = {
      kind: 'import-edge',
      specifier: ref.specifier,
      resolved: isResolved,
      ...(resolvedRel !== undefined ? { resolvedPath: resolvedRel } : {}),
      ...(Object.keys(metaFlags).length > 0 ? { meta: metaFlags } : {}),
    };

    const location: FactLocation = {
      file: relPath as FactLocation['file'],
      startLine: ref.startLine,
      endLine: ref.endLine,
    };

    out.push({
      kind: 'import-edge',
      resolved: isResolved,
      location,
      anchors: [{ key: `js-module:${anchorBody}` as AnchorKey, role: 'module' }],
      payload,
    });
  });
  return out;
}

function collectSpecifiers(sf: ts.SourceFile, visit: (r: SpecifierRef) => void): void {
  const walk = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      visit(refFor(n.moduleSpecifier, sf, isTypeOnlyImport(n)));
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      visit(refFor(n.moduleSpecifier, sf, isTypeOnlyExport(n)));
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg)) visit(refFor(arg, sf, false));
    } else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'require'
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg)) visit(refFor(arg, sf, false));
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
  return clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
  return node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly);
}

function refFor(node: ts.StringLiteral, sf: ts.SourceFile, typeOnly: boolean): SpecifierRef {
  const pos = node.getStart(sf);
  const start = sf.getLineAndCharacterOfPosition(pos).line + 1;
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { specifier: node.text, startLine: start, endLine: end, pos, typeOnly };
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
