import { describe, it, expect } from 'vitest';
import { parseArgv } from '../../src/cli/argv.js';

describe('parseArgv — empty argv and top-level flags', () => {
  it('empty argv parses to help (spec §CLI: bare invocation is a help request)', () => {
    const r = parseArgv({ argv: [], stdinIsTty: true });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.kind).toBe('help');
  });

  it('--help parses to help', () => {
    const r = parseArgv({ argv: ['--help'], stdinIsTty: true });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.kind).toBe('help');
  });

  it('-h parses to help', () => {
    const r = parseArgv({ argv: ['-h'], stdinIsTty: true });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.kind).toBe('help');
  });

  it('--version parses to version', () => {
    const r = parseArgv({ argv: ['--version'], stdinIsTty: true });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.kind).toBe('version');
  });

  it('an unknown top-level command is a CliError with a helpful message', () => {
    const r = parseArgv({ argv: ['wat'], stdinIsTty: true });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.kind).toBe('CliError');
      expect(r.error.message).toMatch(/unknown command/i);
      expect(r.error.message).toMatch(/wat/);
    }
  });
});
