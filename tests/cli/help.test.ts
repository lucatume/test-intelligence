import { describe, it, expect } from 'vitest';
import { HELP_TEXT } from '../../src/cli/help.js';

describe('HELP_TEXT', () => {
  it('documents every Plan B command', () => {
    for (const cmd of [
      'ti tests   --from-sources',
      'ti sources --from-tests',
      'ti explain',
      'ti unlock',
      '--help',
      '--version',
    ]) {
      expect(HELP_TEXT).toContain(cmd);
    }
  });

  it('documents every exit code', () => {
    expect(HELP_TEXT).toMatch(/exit\s*0/i);
    expect(HELP_TEXT).toMatch(/exit\s*1/i);
    expect(HELP_TEXT).toMatch(/exit\s*2/i);
  });

  it('mentions --strict, --min-confidence, --format=json, --format=args', () => {
    expect(HELP_TEXT).toMatch(/--strict/);
    expect(HELP_TEXT).toMatch(/--min-confidence/);
    expect(HELP_TEXT).toMatch(/--format/);
  });

  it('mentions the "empty output means run everything" semantics', () => {
    expect(HELP_TEXT).toMatch(/empty/i);
  });
});
