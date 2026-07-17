import { describe, expect, it } from 'vitest';
import { parseArgv } from '../../src/cli/parseArgv.js';

describe('parseArgv', () => {
  it('parses help, version, init, and config', () => {
    expect(parseArgv([])).toEqual({ kind: 'help' });
    expect(parseArgv(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgv(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgv(['init'])).toEqual({ kind: 'init' });
    expect(parseArgv(['config'])).toEqual({ kind: 'config' });
  });

  it('parses a cold tests query with timing', () => {
    expect(parseArgv([
      'tests', '--from-sources', 'src/a.ts', 'src/b.ts',
      '--framework=jest', '--strict', '--timing-top=5',
    ])).toEqual({
      kind: 'tests',
      sources: ['src/a.ts', 'src/b.ts'],
      framework: 'jest',
      format: 'args',
      minConfidence: 0,
      strict: true,
      timing: { emit: true, topN: 5 },
    });
  });

  it('parses a cold sources query with timing', () => {
    expect(parseArgv([
      'sources', '--from-tests', 'jest:tests/a.test.ts::works',
      '--format=json', '--min-confidence=0.5', '--timing',
    ])).toEqual({
      kind: 'sources',
      testIds: ['jest:tests/a.test.ts::works'],
      format: 'json',
      minConfidence: 0.5,
      strict: false,
      timing: { emit: true, topN: 0 },
    });
  });

  it('parses a direct dependency query', () => {
    expect(parseArgv([
      'dependencies', '--from-sources', 'src/a.ts', 'src/b.php',
      '--format=json', '--min-confidence=0.7', '--strict',
    ])).toEqual({
      kind: 'dependencies',
      sources: ['src/a.ts', 'src/b.php'],
      format: 'json',
      minConfidence: 0.7,
      strict: true,
      timing: { emit: false, topN: 0 },
    });
  });

  it.each(['build', 'update', 'clean', 'migrate', 'unlock', 'resolve', 'explain', 'export'])(
    'treats removed stateful command %s as unknown',
    (command) => {
      expect(parseArgv([command])).toEqual({ kind: 'unknown-command', input: command });
    },
  );
});
