import { describe, it, expect } from 'vitest';
import { ok, err } from '../src/result.js';
import { map, mapErr, andThen, unwrapOr } from '../src/result.js';
import { combineAll, combineWithAllErrors } from '../src/result.js';

describe('result constructors', () => {
  it('ok creates a success result', () => {
    const r = ok(42);
    expect(r).toEqual({ kind: 'ok', value: 42 });
  });

  it('err creates an error result', () => {
    const r = err('boom');
    expect(r).toEqual({ kind: 'err', error: 'boom' });
  });
});

describe('result combinators', () => {
  it('map transforms success', () => {
    expect(map(ok(2), (n) => n + 1)).toEqual(ok(3));
  });

  it('map leaves error untouched', () => {
    expect(map(err('x'), (n: number) => n + 1)).toEqual(err('x'));
  });

  it('mapErr transforms error', () => {
    expect(mapErr(err('boom'), (s) => s.length)).toEqual(err(4));
  });

  it('mapErr leaves success untouched', () => {
    expect(mapErr(ok(5), (s: string) => s.length)).toEqual(ok(5));
  });

  it('andThen chains Result-returning functions', () => {
    const divide = (n: number, d: number) => d === 0 ? err('div0') : ok(n / d);
    expect(andThen(ok(10), (n) => divide(n, 2))).toEqual(ok(5));
    expect(andThen(ok(10), (n) => divide(n, 0))).toEqual(err('div0'));
    expect(andThen(err('early'), (_n: number) => divide(_n, 2))).toEqual(err('early'));
  });

  it('unwrapOr returns the value on ok', () => {
    expect(unwrapOr(ok(7), 0)).toBe(7);
  });

  it('unwrapOr returns the default on err', () => {
    expect(unwrapOr(err('nope'), 99)).toBe(99);
  });
});

describe('result combineAll (fail-fast)', () => {
  it('combines an array of oks into ok-of-array', () => {
    expect(combineAll([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
  });

  it('returns the first error encountered', () => {
    expect(combineAll([ok(1), err('first'), err('second')])).toEqual(err('first'));
  });

  it('handles the empty case', () => {
    expect(combineAll([])).toEqual(ok([]));
  });
});

describe('result combineWithAllErrors (accumulating)', () => {
  it('combines oks into ok-of-array', () => {
    expect(combineWithAllErrors([ok(1), ok(2)])).toEqual(ok([1, 2]));
  });

  it('accumulates all errors', () => {
    expect(combineWithAllErrors([ok(1), err('a'), ok(2), err('b')])).toEqual(err(['a', 'b']));
  });

  it('handles the empty case', () => {
    expect(combineWithAllErrors([])).toEqual(ok([]));
  });
});
