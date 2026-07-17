import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { extractSymbols, extractSymbolUses, extractWpGlobalSymbols } from '../../../src/extract/ts/symbols.js';

function parse(rel: string, src: string): ts.SourceFile {
  return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function payloadOf(arr: { payload: unknown }[], i: number): unknown {
  const entry = arr[i];
  if (!entry) throw new Error(`missing index ${String(i)}`);
  return entry.payload;
}

describe('extractSymbols', () => {
  it('emits named export function', () => {
    const sf = parse('src/cart.ts', 'export function addItem() {}\n');
    const facts = extractSymbols(sf, 'src/cart.ts');
    expect(facts).toHaveLength(1);
    expect(payloadOf(facts, 0)).toMatchObject({ name: 'addItem', exported: true });
    const [first] = facts;
    if (!first) throw new Error('no fact');
    const [anchor] = first.anchors;
    if (!anchor) throw new Error('no anchor');
    expect(anchor.key).toBe('js-symbol:src/cart.ts:addItem');
  });

  it('emits default export', () => {
    const sf = parse('src/cart.ts', 'export default function () {}\n');
    const facts = extractSymbols(sf, 'src/cart.ts');
    expect(facts).toHaveLength(1);
    expect(payloadOf(facts, 0)).toMatchObject({ name: 'default', exported: true });
  });

  it('emits non-exported top-level declarations as exported=false', () => {
    const sf = parse('src/cart.ts', 'function privateHelper() {}\nconst x = 1;\n');
    const facts = extractSymbols(sf, 'src/cart.ts');
    const names = facts.map((f) => (f.payload as { name: string }).name).sort();
    expect(names).toEqual(['privateHelper', 'x']);
    expect(facts.every((f) => !(f.payload as { exported: boolean }).exported)).toBe(true);
  });

  it('emits export { a, b as c } statements', () => {
    const sf = parse('src/cart.ts', 'const a = 1; const b = 2; export { a, b as c };\n');
    const facts = extractSymbols(sf, 'src/cart.ts');
    const exported = facts
      .filter((f) => (f.payload as { exported: boolean }).exported)
      .map((f) => (f.payload as { name: string }).name)
      .sort();
    expect(exported).toEqual(['a', 'c']);
  });

  it('emits class and interface', () => {
    const sf = parse('src/cart.ts', 'export class Cart {}\nexport interface Item {}\n');
    const facts = extractSymbols(sf, 'src/cart.ts');
    const names = facts.map((f) => (f.payload as { name: string }).name).sort();
    expect(names).toEqual(['Cart', 'Item']);
  });

  it('emits a symbol-def per class method', () => {
    const sf = parse('src/cart.ts', 'export class Cart {\n  addItem() {}\n  removeItem() {}\n}\n');
    const facts = extractSymbols(sf, 'src/cart.ts');
    const keys = facts.map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual([
      'js-symbol:src/cart.ts:Cart',
      'js-symbol:src/cart.ts:Cart#addItem',
      'js-symbol:src/cart.ts:Cart#removeItem',
    ]);
    const method = facts.find((f) => f.anchors[0]?.key === 'js-symbol:src/cart.ts:Cart#addItem');
    expect(method?.payload).toMatchObject({ kind: 'symbol-def', name: 'Cart#addItem', exported: false });
    expect(method?.anchors[0]?.role).toBe('subject');
  });

  it('skips the constructor and computed-name methods', () => {
    const src = 'class Cart {\n  constructor() {}\n  ["dynamic"]() {}\n  real() {}\n}\n';
    const sf = parse('src/cart.ts', src);
    const facts = extractSymbols(sf, 'src/cart.ts');
    const keys = facts.map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual(['js-symbol:src/cart.ts:Cart', 'js-symbol:src/cart.ts:Cart#real']);
  });

  it('emits get/set accessors and static methods as method symbol-defs', () => {
    const src = 'class Cart {\n  static make() {}\n  get total() { return 0; }\n}\n';
    const sf = parse('src/cart.ts', src);
    const facts = extractSymbols(sf, 'src/cart.ts');
    const keys = facts.map((f) => f.anchors[0]?.key).sort();
    expect(keys).toEqual([
      'js-symbol:src/cart.ts:Cart',
      'js-symbol:src/cart.ts:Cart#make',
      'js-symbol:src/cart.ts:Cart#total',
    ]);
  });
});

describe('extractSymbolUses', () => {
  function uses(src: string, relPath = 'a.ts') {
    const sf = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    return extractSymbolUses(sf, relPath, '/proj', { allowJs: true }).filter((f) => f.kind === 'symbol-use');
  }

  it('emits symbol-use for a call to a same-file declared function', () => {
    const facts = uses('function helper() {}\nfunction main() { helper(); }');
    const keys = facts.map((f) => f.anchors[0]?.key);
    expect(keys).toContain('js-symbol:a.ts:helper');
    const helper = facts.find((f) => f.anchors[0]?.key === 'js-symbol:a.ts:helper');
    expect(helper?.anchors[0]?.role).toBe('target');
    expect(helper?.resolved).toBe(true);
  });

  it('dedups repeated calls to the same symbol', () => {
    const facts = uses('function helper() {}\nfunction main() { helper(); helper(); helper(); }');
    expect(facts.filter((f) => f.anchors[0]?.key === 'js-symbol:a.ts:helper')).toHaveLength(1);
  });

  it('does not emit symbol-use for an undeclared global', () => {
    const facts = uses('function main() { setTimeout(() => {}, 0); }');
    expect(facts).toHaveLength(0);
  });

  it('resolves a named import call to the imported file', () => {
    const root = mkdtempSync(join(tmpdir(), 'ti_deletemeelephant_su_'));
    try {
      writeFileSync(join(root, 'bar.ts'), 'export function foo() {}\n');
      const src = "import { foo } from './bar';\nfoo();\n";
      writeFileSync(join(root, 'a.ts'), src);
      const sf = ts.createSourceFile(join(root, 'a.ts'), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const facts = extractSymbolUses(sf, 'a.ts', root, { allowJs: true }).filter((f) => f.kind === 'symbol-use');
      expect(facts.map((f) => f.anchors[0]?.key)).toContain('js-symbol:bar.ts:foo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the imported name for an aliased default import', () => {
    const root = mkdtempSync(join(tmpdir(), 'ti_deletemeelephant_su_'));
    try {
      writeFileSync(join(root, 'bar.ts'), 'export default function () {}\n');
      const src = "import myDefault from './bar';\nmyDefault();\n";
      writeFileSync(join(root, 'a.ts'), src);
      const sf = ts.createSourceFile(join(root, 'a.ts'), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const facts = extractSymbolUses(sf, 'a.ts', root, { allowJs: true }).filter((f) => f.kind === 'symbol-use');
      expect(facts.map((f) => f.anchors[0]?.key)).toContain('js-symbol:bar.ts:default');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not emit for a call to a bare-package import', () => {
    const root = mkdtempSync(join(tmpdir(), 'ti_deletemeelephant_su_'));
    try {
      const src = "import { render } from 'react-dom';\nrender();\n";
      writeFileSync(join(root, 'a.ts'), src);
      const sf = ts.createSourceFile(join(root, 'a.ts'), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const facts = extractSymbolUses(sf, 'a.ts', root, { allowJs: true }).filter((f) => f.kind === 'symbol-use');
      expect(facts).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renames an aliased named import to its imported name', () => {
    const root = mkdtempSync(join(tmpdir(), 'ti_deletemeelephant_su_'));
    try {
      writeFileSync(join(root, 'bar.ts'), 'export function foo() {}\n');
      const src = "import { foo as localFoo } from './bar';\nlocalFoo();\n";
      writeFileSync(join(root, 'a.ts'), src);
      const sf = ts.createSourceFile(join(root, 'a.ts'), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const facts = extractSymbolUses(sf, 'a.ts', root, { allowJs: true }).filter((f) => f.kind === 'symbol-use');
      expect(facts.map((f) => f.anchors[0]?.key)).toContain('js-symbol:bar.ts:foo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves this.method() to a same-file method symbol-def', () => {
    const facts = uses(
      'class Cart {\n  doThing() { this.helper(); }\n  helper() {}\n}\n',
    );
    expect(facts.map((f) => f.anchors[0]?.key)).toContain('js-symbol:a.ts:Cart#helper');
    const use = facts.find((f) => f.anchors[0]?.key === 'js-symbol:a.ts:Cart#helper');
    expect(use?.anchors[0]?.role).toBe('target');
    expect(use?.resolved).toBe(true);
  });

  it('skips this.method() when the method is not declared on the class', () => {
    const facts = uses('class Cart {\n  doThing() { this.inherited(); }\n}\n');
    expect(facts.map((f) => f.anchors[0]?.key)).not.toContain('js-symbol:a.ts:Cart#inherited');
    expect(facts).toHaveLength(0);
  });

  it('dedups repeated this.method() calls', () => {
    const facts = uses(
      'class Cart {\n  doThing() { this.helper(); this.helper(); }\n  helper() {}\n}\n',
    );
    expect(facts.filter((f) => f.anchors[0]?.key === 'js-symbol:a.ts:Cart#helper')).toHaveLength(1);
  });

  it('resolves a namespace-import member call to the imported file', () => {
    const root = mkdtempSync(join(tmpdir(), 'ti_deletemeelephant_su_'));
    try {
      writeFileSync(join(root, 'mod.ts'), 'export function foo() {}\n');
      const src = "import * as mod from './mod';\nmod.foo();\n";
      writeFileSync(join(root, 'a.ts'), src);
      const sf = ts.createSourceFile(join(root, 'a.ts'), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const facts = extractSymbolUses(sf, 'a.ts', root, { allowJs: true }).filter((f) => f.kind === 'symbol-use');
      expect(facts.map((f) => f.anchors[0]?.key)).toContain('js-symbol:mod.ts:foo');
      const use = facts.find((f) => f.anchors[0]?.key === 'js-symbol:mod.ts:foo');
      expect(use?.anchors[0]?.role).toBe('target');
      expect(use?.resolved).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves new mod.Thing() through a namespace import', () => {
    const root = mkdtempSync(join(tmpdir(), 'ti_deletemeelephant_su_'));
    try {
      writeFileSync(join(root, 'mod.ts'), 'export class Thing {}\n');
      const src = "import * as mod from './mod';\nnew mod.Thing();\n";
      writeFileSync(join(root, 'a.ts'), src);
      const sf = ts.createSourceFile(join(root, 'a.ts'), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const facts = extractSymbolUses(sf, 'a.ts', root, { allowJs: true }).filter((f) => f.kind === 'symbol-use');
      expect(facts.map((f) => f.anchors[0]?.key)).toContain('js-symbol:mod.ts:Thing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not emit for a namespace member call when the module is unresolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'ti_deletemeelephant_su_'));
    try {
      const src = "import * as lib from 'some-bare-package';\nlib.doThing();\n";
      writeFileSync(join(root, 'a.ts'), src);
      const sf = ts.createSourceFile(join(root, 'a.ts'), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const facts = extractSymbolUses(sf, 'a.ts', root, { allowJs: true }).filter((f) => f.kind === 'symbol-use');
      expect(facts).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not emit for member access on an arbitrary local variable', () => {
    const facts = uses('function make() { return {}; }\nconst obj = make();\nobj.foo();');
    expect(facts.map((f) => f.anchors[0]?.key)).not.toContain('js-symbol:a.ts:foo');
  });
});

describe('extractWpGlobalSymbols', () => {
  it('normalizes window.wp and connects assignments to member reads', () => {
    const sf = parse('x.js', `
      window.wp.mediaWidgets = {};
      void wp.mediaWidgets;
      new wp.mediaWidgets.MediaWidgetControl();
    `);
    const facts = extractWpGlobalSymbols(sf, 'x.js');
    expect(facts.map((f) => [f.kind, f.anchors[0]?.key, f.anchors[0]?.role])).toEqual([
      ['symbol-def', 'js-global:wp.mediaWidgets', 'target'],
      ['symbol-use', 'js-global:wp.mediaWidgets', 'subject'],
      ['symbol-use', 'js-global:wp.mediaWidgets.MediaWidgetControl', 'subject'],
    ]);
  });

  it('ignores globals other than wp', () => {
    const sf = parse('x.js', 'window.foo.bar = {}; foo.bar();');
    expect(extractWpGlobalSymbols(sf, 'x.js')).toEqual([]);
  });

  it('does not fan deep member reads out to the global namespace root', () => {
    const sf = parse('x.js', 'wp.mediaWidgets.controlConstructors.gallery();');
    const keys = extractWpGlobalSymbols(sf, 'x.js', 'qunit').map((f) => f.anchors[0]?.key);
    expect(keys).toEqual([
      'js-global:wp.mediaWidgets.controlConstructors',
      'js-global:wp.mediaWidgets.controlConstructors.gallery',
    ]);
  });
});
