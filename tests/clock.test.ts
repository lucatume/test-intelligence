import { describe, it, expect } from 'vitest';
import { systemClock, systemRandom, fixedClock, seededRandom } from '../src/clock.js';
import type { ISODate } from '../src/types.js';

describe('systemClock', () => {
  it('returns an ISO8601 UTC timestamp', () => {
    const now = systemClock.now();
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });
});

describe('fixedClock', () => {
  it('always returns the configured timestamp', () => {
    const fixed: ISODate = '2026-04-21T00:00:00Z' as ISODate;
    const c = fixedClock(fixed);
    expect(c.now()).toBe(fixed);
    expect(c.now()).toBe(fixed);
  });
});

describe('systemRandom', () => {
  it('returns a number in [0, 1)', () => {
    for (let i = 0; i < 100; i++) {
      const n = systemRandom.next();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
});

describe('seededRandom', () => {
  it('is deterministic for the same seed', () => {
    const r1 = seededRandom(42);
    const r2 = seededRandom(42);
    for (let i = 0; i < 10; i++) {
      expect(r1.next()).toBe(r2.next());
    }
  });

  it('produces different sequences for different seeds', () => {
    const r1 = seededRandom(1);
    const r2 = seededRandom(2);
    expect(r1.next()).not.toBe(r2.next());
  });
});
