import { describe, it, expect } from 'vitest';
import { resolveStatus } from '../../src/resolve/status.js';
import { upsertResolution } from '../../src/store/writers.js';
import { fixtureWithUnresolvedHookFacts } from './_helpers.js';

const GEN = '2026-05-17T00:00:00.000Z';

describe('resolveStatus', () => {
  it('reports unresolved counts, cached counts, and class histogram per kind', () => {
    const db = fixtureWithUnresolvedHookFacts(['h1', 'h2', 'h3']);
    upsertResolution(db, { exprHash: 'h1', pass: 'llm', resolvedValue: { hookName: 'x' },
      classification: 'structural-rule', citePath: 'a.php', citeLine: 1,
      citeVerified: true, importedAt: GEN });
    const s = resolveStatus(db);
    expect(s.unresolved['hook-fire'] + s.unresolved['hook-listener']).toBe(3);
    expect(s.cached).toBe(1);
    expect(s.classHistogram['structural-rule']).toBe(1);
  });

  it('prunes stale cached resolutions and reports the stale count', () => {
    const db = fixtureWithUnresolvedHookFacts(['h1']);
    upsertResolution(db, { exprHash: 'h1', pass: 'llm', resolvedValue: { hookName: 'x' },
      classification: 'structural-rule', citePath: 'a.php', citeLine: 1,
      citeVerified: true, importedAt: GEN });
    upsertResolution(db, { exprHash: 'dead', pass: 'llm', resolvedValue: {},
      classification: 'data-dependent-unresolvable', citePath: '', citeLine: 0,
      citeVerified: false, importedAt: GEN });
    const s = resolveStatus(db);
    expect(s.stale).toBe(1);
    expect(s.cached).toBe(1);
  });
});
