import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { buildResolutionProgram } from '../../src/jsresolve/program.js';
import { resolveExpression } from '../../src/jsresolve/resolver.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const getTmp = useTmpDir('ti-jsresolve-resolver-');

// Build a program from {relPath: source} fixtures, find the first
// `apiFetch(X)` call in `entry`, return resolveExpression of X.
function resolveApiFetchArg(files: Record<string, string>, entry: string): string | null {
  const root = getTmp();
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  const { program, checker } = buildResolutionProgram([join(root, entry)], root);
  const sf = program.getSourceFile(join(root, entry));
  if (!sf) throw new Error('entry not in program');
  let arg: ts.Expression | undefined;
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
        n.expression.text === 'apiFetch' && n.arguments[0]) {
      arg ??= n.arguments[0];
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  if (!arg) throw new Error('no apiFetch call');
  const v = resolveExpression(arg, checker, { depth: 0, projectRoot: root });
  if (v.kind === 'object') return typeof v.props['path'] === 'string' ? v.props['path'] : null;
  if (v.kind === 'string') return v.value;
  return null;
}

describe('resolveExpression', () => {
  it('resolves an inline object literal path', () => {
    expect(resolveApiFetchArg(
      { 'a.js': "apiFetch({ path: '/wc/v3/products' });" }, 'a.js',
    )).toBe('/wc/v3/products');
  });

  it('resolves a same-file const', () => {
    expect(resolveApiFetchArg(
      { 'a.js': "const cfg = { path: '/wc/v3/orders' };\napiFetch(cfg);" }, 'a.js',
    )).toBe('/wc/v3/orders');
  });

  it('resolves a path imported from another module', () => {
    expect(resolveApiFetchArg({
      'a.js': "import { ROOT } from './c.js';\napiFetch({ path: ROOT });",
      'c.js': "export const ROOT = '/wc/v3/data';",
    }, 'a.js')).toBe('/wc/v3/data');
  });

  it('folds a template literal whose parts are all resolvable', () => {
    expect(resolveApiFetchArg({
      'a.js': "import { NS } from './c.js';\napiFetch({ path: `${NS}/items` });",
      'c.js': "export const NS = '/wc-admin';",
    }, 'a.js')).toBe('/wc-admin/items');
  });

  it('resolves a value returned by a helper function', () => {
    expect(resolveApiFetchArg({
      'a.js': "import { cfg } from './c.js';\napiFetch(cfg());",
      'c.js': "export function cfg() { return { path: '/wc/v3/x' }; }",
    }, 'a.js')).toBe('/wc/v3/x');
  });

  it('resolves a config threaded through a function parameter', () => {
    expect(resolveApiFetchArg({
      'a.js': "function go(c) { apiFetch(c); }\ngo({ path: '/wc/v3/y' });",
    }, 'a.js')).toBe('/wc/v3/y');
  });

  it('returns unresolved for a genuinely dynamic argument', () => {
    expect(resolveApiFetchArg(
      { 'a.js': "function go(id) { apiFetch({ path: '/wc/v3/' + id }); }" }, 'a.js',
    )).toBe(null);
  });
});
