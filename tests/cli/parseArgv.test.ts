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
    const r = parseArgv(['export']);
    expect(r.kind).toBe('not-implemented');
    if (r.kind === 'not-implemented') expect(r.verb).toBe('export');
  });
  it('unknown verb', () => {
    const r = parseArgv(['frobnicate']);
    expect(r.kind).toBe('unknown-command');
    if (r.kind === 'unknown-command') expect(r.input).toBe('frobnicate');
  });
  it('build parses with default normal verbosity', () => {
    expect(parseArgv(['build'])).toEqual({
      kind: 'build',
      verbosity: 'normal',
      timing: { emit: false, topN: 0 },
    });
  });
  it('build --quiet and --verbose adjust verbosity', () => {
    expect(parseArgv(['build', '--quiet'])).toEqual({
      kind: 'build',
      verbosity: 'quiet',
      timing: { emit: false, topN: 0 },
    });
    expect(parseArgv(['build', '-v'])).toEqual({
      kind: 'build',
      verbosity: 'verbose',
      timing: { emit: false, topN: 0 },
    });
  });
  it('build --timing enables phase emission', () => {
    const r = parseArgv(['build', '--timing']);
    expect(r.kind).toBe('build');
    if (r.kind === 'build') {
      expect(r.timing.emit).toBe(true);
      expect(r.timing.topN).toBe(0);
    }
  });
  it('build --timing-top=N enables emission and per-file collection', () => {
    const r = parseArgv(['build', '--timing-top=10']);
    expect(r.kind).toBe('build');
    if (r.kind === 'build') {
      expect(r.timing.emit).toBe(true);
      expect(r.timing.topN).toBe(10);
    }
  });
  it('update collects positional paths and ignores flags', () => {
    const r = parseArgv(['update', 'src/a.ts', '-q', 'src/b.ts']);
    expect(r.kind).toBe('update');
    if (r.kind === 'update') {
      expect(r.paths).toEqual(['src/a.ts', 'src/b.ts']);
      expect(r.verbosity).toBe('quiet');
      expect(r.timing).toEqual({ emit: false, topN: 0 });
    }
  });
  it('update --timing enables phase emission', () => {
    const r = parseArgv(['update', 'src/a.ts', '--timing']);
    expect(r.kind).toBe('update');
    if (r.kind === 'update') {
      expect(r.timing.emit).toBe(true);
    }
  });
  it('ignores positional args after the verb (deferred to dispatcher)', () => {
    expect(parseArgv(['init', '--force'])).toEqual({ kind: 'init' });
  });
});
