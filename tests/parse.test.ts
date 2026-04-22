import { describe, it, expect } from 'vitest';
import * as P from '../src/parse.js';

describe('parse.string', () => {
  it('accepts a string', () => {
    expect(P.string.parse('hello')).toEqual({ kind: 'ok', value: 'hello' });
  });

  it('rejects a non-string with a path-qualified error', () => {
    expect(P.string.parse(42)).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected string, got number' }],
    });
  });
});

describe('parse.number', () => {
  it('accepts a finite number', () => {
    expect(P.number.parse(3.14)).toEqual({ kind: 'ok', value: 3.14 });
  });

  it('rejects NaN', () => {
    expect(P.number.parse(Number.NaN)).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected finite number, got NaN' }],
    });
  });

  it('rejects Infinity', () => {
    expect(P.number.parse(Number.POSITIVE_INFINITY)).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected finite number, got Infinity' }],
    });
  });

  it('rejects a non-number', () => {
    expect(P.number.parse('nope')).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected number, got string' }],
    });
  });
});

describe('parse.boolean', () => {
  it('accepts true', () => {
    expect(P.boolean.parse(true)).toEqual({ kind: 'ok', value: true });
  });

  it('accepts false', () => {
    expect(P.boolean.parse(false)).toEqual({ kind: 'ok', value: false });
  });

  it('rejects non-boolean', () => {
    expect(P.boolean.parse('true')).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected boolean, got string' }],
    });
  });
});

describe('parse.array', () => {
  it('accepts an array of valid elements', () => {
    const s = P.array(P.number);
    expect(s.parse([1, 2, 3])).toEqual({ kind: 'ok', value: [1, 2, 3] });
  });

  it('rejects a non-array', () => {
    const s = P.array(P.number);
    expect(s.parse('nope')).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected array, got string' }],
    });
  });

  it('accumulates per-element errors with index paths', () => {
    const s = P.array(P.number);
    const r = s.parse([1, 'two', 3, 'four']);
    expect(r).toEqual({
      kind: 'err',
      error: [
        { path: [1], message: 'expected number, got string' },
        { path: [3], message: 'expected number, got string' },
      ],
    });
  });
});

describe('parse.record', () => {
  it('accepts an object with valid values', () => {
    const s = P.record(P.number);
    expect(s.parse({ a: 1, b: 2 })).toEqual({ kind: 'ok', value: { a: 1, b: 2 } });
  });

  it('rejects a non-object', () => {
    const s = P.record(P.number);
    expect(s.parse([1, 2])).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected object, got array' }],
    });
  });

  it('rejects null', () => {
    const s = P.record(P.number);
    expect(s.parse(null)).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected object, got null' }],
    });
  });

  it('accumulates per-key errors', () => {
    const s = P.record(P.number);
    expect(s.parse({ a: 1, b: 'two' })).toEqual({
      kind: 'err',
      error: [{ path: ['b'], message: 'expected number, got string' }],
    });
  });
});

describe('parse.enumOf', () => {
  it('accepts a listed value', () => {
    const s = P.enumOf(['phpunit', 'jest', 'playwright'] as const);
    expect(s.parse('jest')).toEqual({ kind: 'ok', value: 'jest' });
  });

  it('rejects an unlisted value', () => {
    const s = P.enumOf(['a', 'b'] as const);
    expect(s.parse('c')).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected one of [a, b], got "c"' }],
    });
  });

  it('rejects a non-string value', () => {
    const s = P.enumOf(['a', 'b'] as const);
    expect(s.parse(42)).toEqual({
      kind: 'err',
      error: [{ path: [], message: 'expected one of [a, b], got 42' }],
    });
  });
});
