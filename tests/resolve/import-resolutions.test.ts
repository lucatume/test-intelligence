import { describe, it, expect } from 'vitest';
import { importResolutions } from '../../src/resolve/import-resolutions.js';
import type { DeriveParams } from '../../src/derive/derive.js';
import { fixedClock } from '../../src/clock.js';
import { readResolution } from '../../src/store/writers.js';
import { useTmpDir } from '../helpers/tmpDir.js';
import {
  fixtureProjectWithUnresolvedHookFact, readHookFact, anchorKeysForFact,
} from './_helpers.js';
import type { ResolutionsFile } from '../../src/resolve/types.js';
import { unsafeCoerce } from '../helpers/unsafeCoerce.js';
import type { ISODate } from '../../src/types.js';

const clock = fixedClock('2026-05-17T00:00:00.000Z' as ISODate);

const deriveParams: DeriveParams = {
  maxDepth: 100, maxMillisPerTest: 1000, threshold: 0,
  hookStopList: new Set(), maxWildcardMatchesPerAnchor: 64,
};

interface LooseResolution {
  exprHash: string;
  classification: string;
  resolvedValue?: { hookName: string };
  citation?: { path: string; line: number };
}
function file(resolutions: LooseResolution[]): ResolutionsFile {
  return unsafeCoerce({ version: 1, pass: 'llm', resolutions });
}

describe('importResolutions — citation verification', () => {
  const getTmp = useTmpDir('ti-import-rx-');

  it('applies a resolution whose cited line contains the hook name', async () => {
    const root = getTmp();
    const db = fixtureProjectWithUnresolvedHookFact(root, 'h1');
    const r = await importResolutions(db, file([{
      exprHash: 'h1', classification: 'structural-rule',
      resolvedValue: { hookName: 'save_post' },
      citation: { path: 'inc.php', line: 12 },
    }]), { root, deriveParams, clock });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.applied).toBe(1);
  });

  it('rejects a resolution whose cited line lacks the token', async () => {
    const root = getTmp();
    const db = fixtureProjectWithUnresolvedHookFact(root, 'h1');
    const r = await importResolutions(db, file([{
      exprHash: 'h1', classification: 'structural-rule',
      resolvedValue: { hookName: 'not_in_file' },
      citation: { path: 'inc.php', line: 12 },
    }]), { root, deriveParams, clock });
    if (r.kind === 'ok') { expect(r.value.applied).toBe(0); expect(r.value.rejected).toBe(1); }
  });

  it('rejects a resolution whose cited file is missing', async () => {
    const root = getTmp();
    const db = fixtureProjectWithUnresolvedHookFact(root, 'h1');
    const r = await importResolutions(db, file([{
      exprHash: 'h1', classification: 'structural-rule',
      resolvedValue: { hookName: 'save_post' },
      citation: { path: 'nope.php', line: 1 },
    }]), { root, deriveParams, clock });
    if (r.kind === 'ok') expect(r.value.rejected).toBe(1);
  });

  it('marks a resolution stale when its exprHash matches no live fact', async () => {
    const root = getTmp();
    const db = fixtureProjectWithUnresolvedHookFact(root, 'h1');
    const r = await importResolutions(db, file([{
      exprHash: 'GONE', classification: 'structural-rule',
      resolvedValue: { hookName: 'save_post' },
      citation: { path: 'inc.php', line: 12 },
    }]), { root, deriveParams, clock });
    if (r.kind === 'ok') expect(r.value.stale).toBe(1);
  });

  it('caches a data-dependent-unresolvable without touching the fact', async () => {
    const root = getTmp();
    const db = fixtureProjectWithUnresolvedHookFact(root, 'h1');
    const r = await importResolutions(db, file([{
      exprHash: 'h1', classification: 'data-dependent-unresolvable',
    }]), { root, deriveParams, clock });
    if (r.kind === 'ok') expect(r.value.classifiedUnresolvable).toBe(1);
    expect(readResolution(db, 'h1', 'llm')?.classification)
      .toBe('data-dependent-unresolvable');
    expect(readHookFact(db, 'h1').resolved).toBe(0);
  });
});

describe('importResolutions — write-back', () => {
  const getTmp = useTmpDir('ti-import-wb-');

  it('an applied resolution flips resolved, stamps resolvedBy, repoints anchor', async () => {
    const root = getTmp();
    const db = fixtureProjectWithUnresolvedHookFact(root, 'h1');
    await importResolutions(db, file([{
      exprHash: 'h1', classification: 'structural-rule',
      resolvedValue: { hookName: 'save_post' },
      citation: { path: 'inc.php', line: 12 },
    }]), { root, deriveParams, clock });
    const fact = readHookFact(db, 'h1');
    expect(fact.resolved).toBe(1);
    const meta = fact.payload['meta'] as { resolvedBy?: string; resolutionHash?: string };
    expect(meta.resolvedBy).toBe('llm-pass');
    expect(meta.resolutionHash).toBe('h1');
    expect(anchorKeysForFact(db, fact.id)).toContain('hook:save_post');
    // The Phase-0 audit context survives on the resolved fact.
    expect(fact.payload['unresolved_expression']).toBeDefined();
  });
});
