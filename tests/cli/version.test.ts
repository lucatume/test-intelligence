import { describe, it, expect } from 'vitest';
import { versionString } from '../../src/cli/version.js';

describe('versionString', () => {
  it('returns a semver-like or "0.x.y-dev" string', () => {
    const v = versionString();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});
