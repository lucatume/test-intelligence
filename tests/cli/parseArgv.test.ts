import { describe, expect, it } from 'vitest';
import { parseArgv } from '../../src/cli/parseArgv.js';

describe('parseArgv', () => {
  it('--help', () => {
    expect(parseArgv(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgv(['-h'])).toEqual({ kind: 'help' });
  });
  it('--version', () => {
    expect(parseArgv(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgv(['-V'])).toEqual({ kind: 'version' });
  });
  it('no args -> help', () => {
    expect(parseArgv([])).toEqual({ kind: 'help' });
  });
  it('init', () => {
    expect(parseArgv(['init'])).toEqual({ kind: 'init' });
  });
  it('config', () => {
    expect(parseArgv(['config'])).toEqual({ kind: 'config' });
  });
  it('recognized-but-unimplemented verb', () => {
    const r = parseArgv(['build']);
    expect(r.kind).toBe('not-implemented');
    if (r.kind === 'not-implemented') expect(r.verb).toBe('build');
  });
  it('unknown verb', () => {
    const r = parseArgv(['frobnicate']);
    expect(r.kind).toBe('unknown-command');
    if (r.kind === 'unknown-command') expect(r.input).toBe('frobnicate');
  });
  it('ignores positional args after the verb (deferred to dispatcher)', () => {
    expect(parseArgv(['init', '--force'])).toEqual({ kind: 'init' });
    expect(parseArgv(['build', '--from-sources', 'foo.php'])).toEqual({
      kind: 'not-implemented',
      verb: 'build',
    });
  });
});
