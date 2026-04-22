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
