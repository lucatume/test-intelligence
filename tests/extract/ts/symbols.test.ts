import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { extractSymbols, extractSymbolUses } from '../../../src/extract/ts/symbols.js';

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
});
