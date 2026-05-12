import { describe, expect, it } from 'vitest';
import { HELP_TEXT } from '../../src/cli/help.js';

describe('HELP_TEXT', () => {
  it('mentions every Plan A and reserved verb', () => {
    for (const v of [
      'init',
      'config',
      'build',
      'update',
      'tests',
      'sources',
      'explain',
      'clean',
      'migrate',
      'unlock',
      'export',
    ]) {
      expect(HELP_TEXT).toContain(v);
    }
  });

  it('starts with "ti"', () => {
    expect(HELP_TEXT.startsWith('ti')).toBe(true);
  });
});
