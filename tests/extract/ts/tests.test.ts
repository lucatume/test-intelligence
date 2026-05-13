import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { extractTestDefs } from '../../../src/extract/ts/tests.js';

function parse(rel: string, src: string): ts.SourceFile {
  return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe('extractTestDefs', () => {
  it('emits top-level it/test for jest', () => {
    const sf = parse('tests/cart.test.ts', `
      it('adds items', () => {});
      test('removes items', () => {});
    `);
    const facts = extractTestDefs(sf, 'tests/cart.test.ts', 'jest');
    const ids = facts.map((f) => (f.payload as { testId: string }).testId).sort();
    expect(ids).toEqual([
      'jest:tests/cart.test.ts::adds items',
      'jest:tests/cart.test.ts::removes items',
    ]);
  });

  it('flattens nested describes into the id', () => {
    const sf = parse('tests/cart.test.ts', `
      describe('Cart', () => {
        describe('items', () => {
          it('adds', () => {});
        });
      });
    `);
    const facts = extractTestDefs(sf, 'tests/cart.test.ts', 'jest');
    const [first] = facts;
    if (!first) throw new Error('no fact');
    expect((first.payload as { testId: string }).testId).toBe(
      'jest:tests/cart.test.ts::Cart > items > adds',
    );
  });

  it('marks framework playwright', () => {
    const sf = parse('e2e/login.spec.ts', "test('logs in', () => {});");
    const facts = extractTestDefs(sf, 'e2e/login.spec.ts', 'playwright');
    const [first] = facts;
    if (!first) throw new Error('no fact');
    expect((first.payload as { framework: string }).framework).toBe('playwright');
    const [anchor] = first.anchors;
    if (!anchor) throw new Error('no anchor');
    expect(anchor.key).toMatch(/^test:playwright:/);
  });

  it('handles dynamic titles by emitting resolved=false', () => {
    const sf = parse('tests/cart.test.ts', "it(name, () => {});");
    const facts = extractTestDefs(sf, 'tests/cart.test.ts', 'jest');
    expect(facts).toHaveLength(1);
    const [first] = facts;
    if (!first) throw new Error('no fact');
    expect(first.resolved).toBe(false);
  });

  it('returns empty for null framework', () => {
    const sf = parse('src/x.ts', "it('not a test', () => {});");
    const facts = extractTestDefs(sf, 'src/x.ts', null);
    expect(facts).toEqual([]);
  });
});
