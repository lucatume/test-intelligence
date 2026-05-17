// Test-plan item 12 — after an applied import, an edge exists for a test that
// reaches the newly-resolved `hook:` anchor, at confidence x LLM_RESOLUTION.
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';
import {
  upsertFile, insertFact, upsertAnchor, insertFactAnchor, insertTest,
} from '../../src/store/writers.js';
import { importResolutions, type DeriveParams } from '../../src/resolve/import-resolutions.js';
import { BASE_CONFIDENCE, LLM_RESOLUTION } from '../../src/derive/confidence.js';
import { fixedClock } from '../../src/clock.js';
import { useTmpDir } from '../helpers/tmpDir.js';
import { unsafeCoerce } from '../helpers/unsafeCoerce.js';
import type { ISODate } from '../../src/types.js';
import type { ResolutionsFile } from '../../src/resolve/types.js';

const clock = fixedClock('2026-05-17T00:00:00.000Z' as ISODate);
const NOW = '2026-05-17T00:00:00.000Z';
const deriveParams: DeriveParams = {
  maxDepth: 100, maxMillisPerTest: 2000, threshold: 0,
  hookStopList: new Set(), maxWildcardMatchesPerAnchor: 64,
};

describe('importResolutions — re-derive produces an attenuated hook-mediated edge', () => {
  const getTmp = useTmpDir('ti-rederive-');

  it('a test reaching a newly-resolved hook-fire bridges to its listener', async () => {
    const root = getTmp();
    // A real cited file: line 12 carries the hook token.
    const incLines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      incLines.push(i === 12 ? "const HOOK = 'ti_e2e_hook';" : `// line ${String(i)}`);
    }
    mkdirSync(join(root, '.ti'), { recursive: true });
    writeFileSync(join(root, 'fire.php'), incLines.join('\n') + '\n');

    const db = new Database(join(root, '.ti', 'store.db'));
    applyInitialSchema(db);

    // Test file with a test-def; the test fact lives in fire.php so the BFS
    // from the test reaches the unresolved hook-fire in the same file.
    const testFileId = upsertFile(db, {
      path: 'fire.php', language: 'php', contentHash: 'fh', extractedAt: NOW,
      isTest: true, framework: 'phpunit', frameworkClass: 'unit',
    });
    const testFact = insertFact(db, {
      fileId: testFileId, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'test-def', framework: 'phpunit', testId: 'phpunit:fire.php::t' },
    });
    insertTest(db, {
      testId: 'phpunit:fire.php::t', fileId: testFileId,
      framework: 'phpunit', frameworkClass: 'unit', factId: testFact,
    });
    // The unresolved hook-fire fact, same file as the test.
    const broad = upsertAnchor(db, { key: 'hook:{*}', type: 'hook' });
    const fireFact = insertFact(db, {
      fileId: testFileId, kind: 'hook-fire', resolved: false, startLine: 14, endLine: 14,
      payload: {
        kind: 'hook-fire', hook: '{*}',
        unresolved: { scope: '(file)', fields: [{ field: 'hook', expression: 'HOOK' }], exprHash: 'eh1' },
      },
    });
    insertFactAnchor(db, { factId: fireFact, anchorId: broad, role: 'target' });

    // A complementary hook-listener in a separate (non-test) file, already
    // resolved on the exact hook anchor.
    const listenerFileId = upsertFile(db, {
      path: 'listen.php', language: 'php', contentHash: 'lh', extractedAt: NOW,
      isTest: false, framework: null, frameworkClass: null,
    });
    const exactAnchor = upsertAnchor(db, { key: 'hook:ti_e2e_hook', type: 'hook' });
    const listenerFact = insertFact(db, {
      fileId: listenerFileId, kind: 'hook-listener', resolved: true, startLine: 3, endLine: 3,
      payload: { kind: 'hook-listener', hook: 'ti_e2e_hook', callback: 'cb' },
    });
    insertFactAnchor(db, { factId: listenerFact, anchorId: exactAnchor, role: 'subject' });

    const file: ResolutionsFile = unsafeCoerce({
      version: 1, pass: 'llm', resolutions: [{
        exprHash: 'eh1', classification: 'structural-rule',
        resolvedValue: { hookName: 'ti_e2e_hook' },
        citation: { path: 'fire.php', line: 12 },
      }],
    });
    const r = await importResolutions(db, file, { root, deriveParams, clock });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.applied).toBe(1);

    // The re-derive produced a hook-mediated edge from the test to listen.php.
    const edge = db.prepare(
      `SELECT confidence, evidence FROM edge
        WHERE test_id = 'phpunit:fire.php::t' AND source = 'listen.php'`,
    ).get() as { confidence: number; evidence: string } | undefined;
    expect(edge).toBeDefined();
    const evidence = JSON.parse(edge?.evidence ?? '[]') as { kind: string }[];
    expect(evidence.some((e) => e.kind === 'hook-mediated')).toBe(true);

    // The edge confidence is the hook-mediated base x exact x distance(1 hop)
    // x LLM_RESOLUTION — the resolution rode the attenuation factor.
    const expected = BASE_CONFIDENCE['hook-mediated'] * (0.92 ** 1) * LLM_RESOLUTION;
    expect(edge?.confidence).toBeCloseTo(expected, 5);

    db.close();
  });
});
