import { describe, it, expect } from 'vitest';

describe('bootstrap error masking', () => {
  it('surfaces module-load failures as test failures (not warnings)', async () => {
    await expect(
      import('./__poison.js'),
    ).rejects.toThrow(/ti_poison_pill/);
  });
});
