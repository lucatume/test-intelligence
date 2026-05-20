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

  it('returns unresolved for a `+` concat where every operand is dynamic', () => {
    expect(resolveApiFetchArg(
      { 'a.js': "function go(a, b) { apiFetch({ path: a + b }); }" }, 'a.js',
    )).toBe(null);
  });

  it('partial-folds a template whose substitutions mix resolvable and dynamic parts', () => {
    expect(resolveApiFetchArg({
      'a.js': "import { NS } from './c.js';\n" +
              "function update(id) { apiFetch({ path: `${NS}/admin/notes/${id}` }); }\n" +
              "update(42);",
      'c.js': "export const NS = 'wc-admin';",
    }, 'a.js')).toBe('wc-admin/admin/notes/{*}');
  });

  it('partial-folds a `+` concat where one operand is unresolvable', () => {
    expect(resolveApiFetchArg({
      'a.js': "import { NS } from './c.js';\n" +
              "function go(id) { apiFetch({ path: NS + '/items/' + id }); }\n" +
              "go(42);",
      'c.js': "export const NS = '/wc-admin';",
    }, 'a.js')).toBe('/wc-admin/items/{*}');
  });

  it('returns unresolved when every template substitution is dynamic', () => {
    expect(resolveApiFetchArg({
      'a.js': "function go(a, b) { apiFetch({ path: `${a}/${b}` }); }",
    }, 'a.js')).toBe(null);
  });

  it('does not bind a parameter of an exported function (callers may be off-program)', () => {
    expect(resolveApiFetchArg({
      'a.js': "export function go(c) { apiFetch(c); }\ngo({ path: '/local' });",
    }, 'a.js')).toBe(null);
  });

  it('does not bind a parameter of a statement-form exported function', () => {
    expect(resolveApiFetchArg({
      'a.js': "function go(c) { apiFetch(c); }\ngo({ path: '/local' });\nexport { go };",
    }, 'a.js')).toBe(null);
  });

  it('resolves a localized-global member access via ctx.localized', () => {
    const root = getTmp();
    writeFileSync(join(root, 'a.js'), "wp.ajax.post(wcSettings.action);");
    const { program, checker } = buildResolutionProgram([join(root, 'a.js')], root);
    const sf = program.getSourceFile(join(root, 'a.js'));
    if (sf === undefined) throw new Error('source file not found');
    let arg: ts.Expression | undefined;
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments[0]) arg ??= n.arguments[0];
      ts.forEachChild(n, walk);
    };
    walk(sf);
    if (arg === undefined) throw new Error('no call expression found');
    const v = resolveExpression(arg, checker, {
      depth: 0, projectRoot: root,
      localized: (obj) => (obj === 'wcSettings' ? { action: 'do_thing' } : null),
    });
    expect(v).toEqual({ kind: 'string', value: 'do_thing' });
  });

  it('unwraps addQueryArgs(literal, …) to the literal first argument', () => {
    expect(resolveApiFetchArg({
      'a.js': "apiFetch({ path: addQueryArgs('/wc/v3/products', { search: 'x' }) });",
    }, 'a.js')).toBe('/wc/v3/products');
  });

  it('unwraps addQueryArgs through a local-const alias', () => {
    expect(resolveApiFetchArg({
      'a.js':
        "function* getNotes(q) {\n" +
        "  const url = addQueryArgs('/wc/admin/notes', q);\n" +
        "  yield apiFetch({ path: url });\n" +
        "}",
    }, 'a.js')).toBe('/wc/admin/notes');
  });

  it('unwraps addQueryArgs with a template-literal first arg that uses an imported NS', () => {
    expect(resolveApiFetchArg({
      'a.js':
        "import { NS } from './c.js';\n" +
        "function* x(q) { yield apiFetch({ path: addQueryArgs(`${NS}/admin/notes`, q) }); }",
      'c.js': "export const NS = '/wc';",
    }, 'a.js')).toBe('/wc/admin/notes');
  });

  it('does not unwrap an in-program function whose body returns something other than its first arg', () => {
    // Verifies the whitelist defers to body-resolution when an in-program
    // definition exists: a user-defined addQueryArgs returning its second arg
    // must NOT be unwrapped to the first.
    expect(resolveApiFetchArg({
      'a.js':
        "function addQueryArgs(_p, q) { return q; }\n" +
        "apiFetch({ path: addQueryArgs('/wrong', '/right') });",
    }, 'a.js')).toBe('/right');
  });
});
