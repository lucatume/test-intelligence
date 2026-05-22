import { describe, it, expect } from 'vitest';
import { pickSlot } from '../../../src/extract/php/pool.js';

describe('pickSlot', () => {
  it('returns the index of the least-busy live slot', () => {
    expect(pickSlot([{ pending: 3, dead: false }, { pending: 1, dead: false }])).toBe(1);
    expect(pickSlot([{ pending: 0, dead: false }, { pending: 0, dead: false }])).toBe(0);
  });

  it('skips dead slots', () => {
    expect(pickSlot([{ pending: 0, dead: true }, { pending: 5, dead: false }])).toBe(1);
  });

  it('returns -1 when every slot is dead', () => {
    expect(pickSlot([{ pending: 0, dead: true }, { pending: 0, dead: true }])).toBe(-1);
  });

  it('returns -1 for an empty slot list', () => {
    expect(pickSlot([])).toBe(-1);
  });

  it('breaks pending ties toward the lowest live index, skipping a dead slot', () => {
    expect(pickSlot([
      { pending: 0, dead: true },
      { pending: 0, dead: false },
      { pending: 0, dead: false },
    ])).toBe(1);
  });
});
