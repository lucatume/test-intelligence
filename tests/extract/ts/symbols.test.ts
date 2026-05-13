import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { extractSymbols } from '../../../src/extract/ts/symbols.js';

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
