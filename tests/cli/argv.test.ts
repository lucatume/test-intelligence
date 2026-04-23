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

describe('parseArgv — ti tests --from-sources', () => {
  it('parses the canonical S1 invocation', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', 'src/Cart.php', 'src/cart.ts', '--framework=phpunit'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'tests') {
      expect(r.value.framework).toBe('phpunit');
      expect(r.value.format).toBe('args');
      expect(r.value.strict).toBe(false);
      expect(r.value.minConfidence).toBeUndefined();
      expect(r.value.fromSources).toEqual({ kind: 'args', values: ['src/Cart.php', 'src/cart.ts'] });
    }
  });

  it('accepts --framework jest (space form)', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', 'src/x.ts', '--framework', 'jest'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'tests') expect(r.value.framework).toBe('jest');
  });

  it('accepts --format=json', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', 'src/x.ts', '--framework=playwright', '--format=json'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'tests') expect(r.value.format).toBe('json');
  });

  it('accepts --min-confidence=0.5 and --strict', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', 'src/x.ts', '--framework=phpunit', '--min-confidence=0.5', '--strict'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'tests') {
      expect(r.value.minConfidence).toBeCloseTo(0.5);
      expect(r.value.strict).toBe(true);
    }
  });

  it('falls back to stdin when no positionals and stdin is not a TTY', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', '--framework=phpunit'],
      stdinIsTty: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'tests') {
      expect(r.value.fromSources).toEqual({ kind: 'stdin' });
    }
  });

  it('rejects when no positionals and stdin is a TTY', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', '--framework=phpunit'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.message).toMatch(/no source paths/i);
  });

  it('rejects missing --framework', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', 'src/x.ts'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.message).toMatch(/--framework/);
  });

  it('rejects unknown framework name', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', 'src/x.ts', '--framework=mocha'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.message).toMatch(/mocha/);
  });

  it('rejects --min-confidence outside [0, 1]', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', 'src/x.ts', '--framework=phpunit', '--min-confidence=1.5'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.message).toMatch(/min-confidence/i);
  });

  it('rejects unknown flag', () => {
    const r = parseArgv({
      argv: ['tests', '--from-sources', 'src/x.ts', '--framework=phpunit', '--turbo'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.message).toMatch(/--turbo/);
  });
});

describe('parseArgv — ti sources --from-tests', () => {
  it('accepts test ids and test file paths mixed', () => {
    const r = parseArgv({
      argv: ['sources', '--from-tests', 'tests/Shop/CartTest.php', 'phpunit:tests/api/UsersTest.php::testCreate'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'sources') {
      expect(r.value.fromTests).toEqual({
        kind: 'args',
        values: ['tests/Shop/CartTest.php', 'phpunit:tests/api/UsersTest.php::testCreate'],
      });
      expect(r.value.format).toBe('args');
    }
  });

  it('rejects --framework for sources (it has no effect here per spec)', () => {
    const r = parseArgv({
      argv: ['sources', '--from-tests', 'tests/x.ts', '--framework=jest'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.message).toMatch(/--framework/);
  });

  it('accepts --format=json', () => {
    const r = parseArgv({
      argv: ['sources', '--from-tests', 'tests/x.ts', '--format=json'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'sources') expect(r.value.format).toBe('json');
  });

  it('falls back to stdin when no positionals and stdin is not a TTY', () => {
    const r = parseArgv({ argv: ['sources', '--from-tests'], stdinIsTty: false });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'sources') {
      expect(r.value.fromTests).toEqual({ kind: 'stdin' });
    }
  });
});

describe('parseArgv — ti explain', () => {
  it('accepts a single positional id or path', () => {
    const r = parseArgv({
      argv: ['explain', 'phpunit:tests/Shop/CartTest.php::testAdd'],
      stdinIsTty: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'explain') {
      expect(r.value.target).toBe('phpunit:tests/Shop/CartTest.php::testAdd');
    }
  });

  it('rejects when no target given', () => {
    const r = parseArgv({ argv: ['explain'], stdinIsTty: true });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.message).toMatch(/target/i);
  });

  it('rejects when more than one target given', () => {
    const r = parseArgv({ argv: ['explain', 'a', 'b'], stdinIsTty: true });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.message).toMatch(/exactly one/i);
  });

  it('rejects unknown flags', () => {
    const r = parseArgv({ argv: ['explain', 'a', '--strict'], stdinIsTty: true });
    expect(r.kind).toBe('err');
  });
});

describe('parseArgv — ti unlock', () => {
  it('parses with no flags (force=false)', () => {
    const r = parseArgv({ argv: ['unlock'], stdinIsTty: true });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'unlock') expect(r.value.force).toBe(false);
  });

  it('parses --force', () => {
    const r = parseArgv({ argv: ['unlock', '--force'], stdinIsTty: true });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.kind === 'unlock') expect(r.value.force).toBe(true);
  });

  it('rejects positional arguments', () => {
    const r = parseArgv({ argv: ['unlock', 'extra'], stdinIsTty: true });
    expect(r.kind).toBe('err');
  });
});
