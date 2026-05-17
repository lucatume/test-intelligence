import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { exprHash } from '../../../src/extract/declarative/exprHash.js';

describe('exprHash', () => {
  it('is deterministic for the same input', () => {
    const a = exprHash('Acme\\Cls::run', [{ field: 'hook', expression: '$hook' }]);
    const b = exprHash('Acme\\Cls::run', [{ field: 'hook', expression: '$hook' }]);
    expect(a).toBe(b);
  });

  it('is independent of field order', () => {
    const a = exprHash('s', [
      { field: 'namespace', expression: '$ns' },
      { field: 'route', expression: '$rt' },
    ]);
    const b = exprHash('s', [
      { field: 'route', expression: '$rt' },
      { field: 'namespace', expression: '$ns' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when the expression changes', () => {
    const a = exprHash('s', [{ field: 'hook', expression: '$hook' }]);
    const b = exprHash('s', [{ field: 'hook', expression: '$h' }]);
    expect(a).not.toBe(b);
  });

  it('changes when the scope changes', () => {
    const a = exprHash('Cls::a', [{ field: 'hook', expression: '$hook' }]);
    const b = exprHash('Cls::b', [{ field: 'hook', expression: '$hook' }]);
    expect(a).not.toBe(b);
  });

  // Pins the canonical digest. Canonical string: `scope` + '\n' + sorted
  // `field=expression` lines each terminated by '\n', sha256 hex.
  it('matches the pinned canonical digest', () => {
    const h = exprHash('(file)', [{ field: 'hook', expression: '$hook' }]);
    expect(h).toBe(
      // sha256 of "(file)\nhook=$hook\n"
      '0ad14095e39f88c62969e16eb0c588064416cb7146c516dfab0fa0aaa97f11fe',
    );
  });
});

describe('exprHash PHP parity', () => {
  it('TS exprHash equals PHP hash() of the same canonical string', () => {
    const scope = 'Widget::run';
    const fields = [{ field: 'hook', expression: '$hook' }];
    const tsHash = exprHash(scope, fields);
    // Canonical string per the spec: scope + '\n' + sorted field=expr lines.
    const canonical = `${scope}\nhook=$hook\n`;
    // Pass the canonical string base64-encoded so no PHP string-interpolation
    // or shell quoting can corrupt it.
    const b64 = Buffer.from(canonical, 'utf8').toString('base64');
    const phpHash = execFileSync('php', [
      '-r',
      `echo hash('sha256', base64_decode('${b64}'));`,
    ])
      .toString()
      .trim();
    expect(tsHash).toBe(phpHash);
  });
});
