import type { ISODate } from './types.js';

// Clock and Random are injected dependencies; production code never calls
// `Date.now()`, `new Date()`, or `Math.random()` directly. The `no-restricted-globals`
// ESLint rule forbids those globals outside this file.

export interface Clock {
  now(): ISODate;
}

export interface Random {
  next(): number; // [0, 1)
}

// eslint-disable-next-line no-restricted-globals -- the one permitted Date use
const nativeDate = Date;

export const systemClock: Clock = {
  now(): ISODate {
    return new nativeDate().toISOString() as ISODate;
  },
};

export function fixedClock(value: ISODate): Clock {
  return { now: () => value };
}

const nativeMath = Math;

export const systemRandom: Random = {
  next: () => nativeMath.random(),
};

// Small xorshift32 — sufficient for tests; not cryptographic.
export function seededRandom(seed: number): Random {
  let state = seed | 0 || 1;
  return {
    next(): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      // Map 32-bit signed int to [0, 1).
      return ((state >>> 0) / 0x1_0000_0000);
    },
  };
}
