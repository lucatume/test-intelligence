import { describe, expect, it } from 'vitest';
import { HELP_TEXT } from '../../src/cli/help.js';

describe('HELP_TEXT', () => {
  it('mentions the stateless commands', () => {
    for (const v of ['init', 'config', 'tests', 'sources']) {
      expect(HELP_TEXT).toContain(v);
    }
    for (const v of ['build', 'update', 'clean', 'migrate', 'unlock', 'resolve']) {
      expect(HELP_TEXT).not.toContain(`ti ${v}`);
    }
  });

  it('starts with "ti"', () => {
    expect(HELP_TEXT.startsWith('ti')).toBe(true);
  });
});
