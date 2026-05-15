import { describe, it, expect } from 'vitest';
import { contentHash } from '../../src/build/contentHash.js';

describe('contentHash', () => {
  it('returns the sha1 hex of the UTF-8 text', () => {
    expect(contentHash('export const a = 1;')).toBe(
      '0d437434569fdbbd74283b98e427d4d627bce29a',
    );
  });

  it('is stable for the same input', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });

  it('differs for different input', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
