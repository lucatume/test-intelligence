import { describe, it, expect } from 'vitest';
import { buildBundle } from '../../src/resolve/build-bundle.js';
import { upsertResolution, readResolution } from '../../src/store/writers.js';
import { useTmpDir } from '../helpers/tmpDir.js';
import { fixtureWithUnresolvedHookFacts } from './_helpers.js';

const GEN = '2026-05-17T00:00:00.000Z' as const;

function params(root: string, over: Partial<Parameters<typeof buildBundle>[1]> = {}): Parameters<typeof buildBundle>[1] {
  return {
    kinds: ['hook-fire', 'hook-listener'], force: false,
    projectRoot: root, generatedAt: GEN, ...over,
  };
}

describe('buildBundle', () => {
  const getTmp = useTmpDir('ti-build-bundle-');

  it('emits one unit per resolved=0 hook fact', () => {
    const root = getTmp();
    const db = fixtureWithUnresolvedHookFacts(['h1', 'h2'], 'inc.php', root);
    const r = buildBundle(db, params(root));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.units.length).toBe(2);
      expect(r.value.units[0]?.codeContext.text.length).toBeGreaterThan(0);
    }
  });

  it('skips a fact that already has a cached resolution', () => {
    const root = getTmp();
    const db = fixtureWithUnresolvedHookFacts(['h1', 'h2'], 'inc.php', root);
    upsertResolution(db, { exprHash: 'h1', pass: 'llm', resolvedValue: { hookName: 'x' },
      classification: 'structural-rule', citePath: 'a.php', citeLine: 1,
      citeVerified: true, importedAt: GEN });
    const r = buildBundle(db, params(root));
    if (r.kind === 'ok') expect(r.value.units.map((u) => u.exprHash)).toEqual(['h2']);
  });

  it('force re-offers a cached fact', () => {
    const root = getTmp();
    const db = fixtureWithUnresolvedHookFacts(['h1'], 'inc.php', root);
    upsertResolution(db, { exprHash: 'h1', pass: 'llm', resolvedValue: { hookName: 'x' },
      classification: 'structural-rule', citePath: 'a.php', citeLine: 1,
      citeVerified: true, importedAt: GEN });
    const r = buildBundle(db, params(root, { force: true }));
    if (r.kind === 'ok') expect(r.value.units.length).toBe(1);
  });

  it('returns every unresolved unit (no cap)', () => {
    const root = getTmp();
    const hashes = Array.from({ length: 7 }, (_, i) => `h${String(i)}`);
    const db = fixtureWithUnresolvedHookFacts(hashes, 'inc.php', root);
    const r = buildBundle(db, params(root));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.units).toHaveLength(7);
  });

  it('prunes stale resolution rows before selecting', () => {
    const root = getTmp();
    const db = fixtureWithUnresolvedHookFacts(['h1'], 'inc.php', root);
    upsertResolution(db, { exprHash: 'dead', pass: 'llm', resolvedValue: {},
      classification: 'data-dependent-unresolvable', citePath: '', citeLine: 0,
      citeVerified: false, importedAt: GEN });
    buildBundle(db, params(root));
    expect(readResolution(db, 'dead', 'llm')).toBeNull();
  });
});
