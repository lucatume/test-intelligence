import { describe, it, expect } from 'vitest';
import {
  type TiError,
  exitCodeFor,
  stderrLine,
  EXIT_SUCCESS,
  EXIT_INVOCATION_ERROR,
  EXIT_STRICT_UNKNOWN,
} from '../src/errors.js';

describe('exitCodeFor', () => {
  it.each([
    ['CliError', 1],
    ['ConfigError', 1],
    ['SchemaOutOfRangeError', 1],
    ['MapNotFoundError', 1],
    ['LockHeldError', 1],
    ['LockHostMismatchError', 1],
  ])('%s maps to exit %d', (kind, code) => {
    const err = { kind, message: 'x' } as TiError;
    expect(exitCodeFor(err, { strict: false })).toBe(code);
  });

  it('ShardCorruptError: 0 without --strict, 1 with', () => {
    const err: TiError = { kind: 'ShardCorruptError', message: 'bad json', shardPath: 'a.json' };
    expect(exitCodeFor(err, { strict: false })).toBe(0);
    expect(exitCodeFor(err, { strict: true })).toBe(1);
  });

  it('UnknownInputError: 0 without --strict, 2 with', () => {
    const err: TiError = { kind: 'UnknownInputError', message: 'unknown', inputs: ['x'] };
    expect(exitCodeFor(err, { strict: false })).toBe(0);
    expect(exitCodeFor(err, { strict: true })).toBe(2);
  });
});

describe('stderrLine formatting', () => {
  it('formats severity and message', () => {
    const e: TiError = { kind: 'CliError', message: 'bad flag --foo' };
    expect(stderrLine(e, 'error')).toBe('ti: error: bad flag --foo');
  });

  it('formats warnings the same way', () => {
    const e: TiError = { kind: 'ShardCorruptError', message: 'corrupt shard', shardPath: 'a.json' };
    expect(stderrLine(e, 'warning')).toBe('ti: warning: corrupt shard');
  });
});

describe('exit code constants', () => {
  it('uses named constants for exit codes', () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_INVOCATION_ERROR).toBe(1);
    expect(EXIT_STRICT_UNKNOWN).toBe(2);
  });
});
