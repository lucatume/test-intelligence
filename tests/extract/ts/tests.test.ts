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
    expect((first.payload as { meta?: { scopeRanges?: unknown } }).meta?.scopeRanges).toEqual([
      { startLine: 2, endLine: 6 },
      { startLine: 3, endLine: 5 },
    ]);
  });

  it('handles Playwright describe and test modifiers without emitting hooks or steps', () => {
    const sf = parse('e2e/orders.spec.ts', `
      test.describe.serial('Orders', () => {
        test.beforeAll(async () => {});
        test.skip('skipped', async () => {});
        test('works', async () => {
          await test.step('inside', async () => {});
        });
      });
    `);
    const ids = extractTestDefs(sf, 'e2e/orders.spec.ts', 'playwright')
      .map((f) => (f.payload as { testId: string }).testId);
    expect(ids).toEqual([
      'playwright:e2e/orders.spec.ts::Orders > skipped',
      'playwright:e2e/orders.spec.ts::Orders > works',
    ]);
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

  it('extracts sequential and callback QUnit module scopes', () => {
    const sf = parse('tests/qunit/x.js', `
      QUnit.module('sequential');
      QUnit.test('first', function () {});
      QUnit.module('callback', function () {
        QUnit.module('nested');
        QUnit.test('second', () => {});
      });
    `);
    const ids = extractTestDefs(sf, 'tests/qunit/x.js', 'qunit')
      .map((f) => (f.payload as { testId: string }).testId);
    expect(ids).toEqual([
      'qunit:tests/qunit/x.js::sequential > first',
      'qunit:tests/qunit/x.js::callback > nested > second',
    ]);
  });

  it('extracts QUnit tests inside a classic IIFE', () => {
    const sf = parse('tests/qunit/x.js', `( function( QUnit ) {
      QUnit.module('scope');
      QUnit.test('works', function () {});
    } )( window.QUnit );`);
    expect(extractTestDefs(sf, 'tests/qunit/x.js', 'qunit').map((f) => (f.payload as { testId?: string }).testId))
      .toEqual(['qunit:tests/qunit/x.js::scope > works']);
  });
});
