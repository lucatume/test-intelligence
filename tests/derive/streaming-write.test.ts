import { describe, it, expect } from 'vitest';
import type { Database as BetterDatabase } from 'better-sqlite3';
import { openStore } from '../../src/store/open.js';
import {
  upsertFile,
  insertFact,
  upsertAnchor,
  insertFactAnchor,
  insertTest,
} from '../../src/store/writers.js';
import { derive } from '../../src/derive/derive.js';
import { systemClock } from '../../src/clock.js';
import { useTmpDir } from '../helpers/tmpDir.js';

// Seeds N synthetic tests, each importing a single shared source. Pure JS,
// no PHP — keeps the streaming + write lifecycle isolated from extractor
// behavior so the test purely exercises derive's streamed write pipeline.
function seedFixture(db: BetterDatabase, testCount: number): void {
  const srcFileId = upsertFile(db, {
    path: 'src/shared.ts',
    language: 'ts',
    contentHash: 'h-shared',
    extractedAt: '2026-05-13T00:00:00.000Z',
    isTest: false, framework: null, frameworkClass: null,
  });
  const symbolDefFactId = insertFact(db, {
    fileId: srcFileId,
    kind: 'symbol-def',
    resolved: true,
    startLine: 1, endLine: 1,
    payload: { kind: 'symbol-def', name: 'shared', exported: true },
  });

  for (let i = 0; i < testCount; i++) {
    const testPath = `tests/t${String(i)}.test.ts`;
    const fileId = upsertFile(db, {
      path: testPath,
      language: 'ts',
      contentHash: `h-${String(i)}`,
      extractedAt: '2026-05-13T00:00:00.000Z',
      isTest: true, framework: 'jest', frameworkClass: 'unit',
    });
    insertFact(db, {
      fileId,
      kind: 'import-edge',
      resolved: true,
      startLine: 1, endLine: 1,
      payload: { kind: 'import-edge', specifier: './shared', resolved: true, resolvedPath: 'src/shared.ts' },
    });
    const testFactId = insertFact(db, {
      fileId,
      kind: 'test-def',
      resolved: true,
      startLine: 2, endLine: 2,
      payload: { kind: 'test-def', framework: 'jest', testId: `jest:${testPath}::t` },
    });
    insertTest(db, {
      testId: `jest:${testPath}::t`,
      fileId,
      framework: 'jest',
      frameworkClass: 'unit',
      factId: testFactId,
    });
  }

  // One anchor so loadGraph has at least one row to read. Not strictly
  // needed by the import-edge path (it resolves via payload.resolvedPath),
  // but mirrors the schema invariant used by other tests.
  const anchorId = upsertAnchor(db, { key: 'js-symbol:src/shared.ts:shared', type: 'js-symbol' });
  insertFactAnchor(db, { factId: symbolDefFactId, anchorId, role: 'subject' });
}

describe('derive streamed write', () => {
  const getTmp = useTmpDir('ti-derive-stream-');

  it('recreates edge_source_idx after write', async () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      seedFixture(db, 8);
      await derive({
        db,
        params: { maxDepth: 10, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set() },
        clock: systemClock,
        workers: 2,
      });
      const indexNames = (db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edge'
      `).all() as Array<{ name: string }>).map((r) => r.name).sort();
      expect(indexNames).toContain('edge_source_idx');
    } finally { close(); }
  });

  it('restores PRAGMA synchronous / cache_size / temp_store after write', async () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      seedFixture(db, 4);
      const beforeSync = db.pragma('synchronous', { simple: true }) as number;
      const beforeCache = db.pragma('cache_size', { simple: true }) as number;
      const beforeTemp = db.pragma('temp_store', { simple: true }) as number;
      await derive({
        db,
        params: { maxDepth: 10, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set() },
        clock: systemClock,
        workers: 2,
      });
      expect(db.pragma('synchronous', { simple: true })).toBe(beforeSync);
      expect(db.pragma('cache_size', { simple: true })).toBe(beforeCache);
      expect(db.pragma('temp_store', { simple: true })).toBe(beforeTemp);
    } finally { close(); }
  });

  it('produces identical edges with workers=0 and workers=2 on a small fixture', async () => {
    const root = getTmp();
    const sA = openStore(`${root}/a`);
    const sB = openStore(`${root}/b`);
    if (sA.kind === 'err') throw new Error(sA.error.message);
    if (sB.kind === 'err') throw new Error(sB.error.message);
    const { db: dbA, close: closeA } = sA.value;
    const { db: dbB, close: closeB } = sB.value;
    try {
      seedFixture(dbA, 12);
      seedFixture(dbB, 12);
      const params = { maxDepth: 10, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set<string>() };
      await derive({ db: dbA, params, clock: systemClock, workers: 0 });
      await derive({ db: dbB, params, clock: systemClock, workers: 2 });
      const rowsA = dbA.prepare('SELECT test_id, source, confidence, partial, evidence, provenance FROM edge ORDER BY test_id, source').all();
      const rowsB = dbB.prepare('SELECT test_id, source, confidence, partial, evidence, provenance FROM edge ORDER BY test_id, source').all();
      expect(rowsB).toEqual(rowsA);
    } finally { closeA(); closeB(); }
  });

  it('summary counts match in-process baseline regardless of worker count', async () => {
    const root = getTmp();
    const sA = openStore(`${root}/a`);
    const sB = openStore(`${root}/b`);
    if (sA.kind === 'err') throw new Error(sA.error.message);
    if (sB.kind === 'err') throw new Error(sB.error.message);
    const { db: dbA, close: closeA } = sA.value;
    const { db: dbB, close: closeB } = sB.value;
    try {
      seedFixture(dbA, 5);
      seedFixture(dbB, 5);
      const params = { maxDepth: 10, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set<string>() };
      const a = await derive({ db: dbA, params, clock: systemClock, workers: 0 });
      const b = await derive({ db: dbB, params, clock: systemClock, workers: 2 });
      expect(b.testsProcessed).toBe(a.testsProcessed);
      expect(b.edgesWritten).toBe(a.edgesWritten);
      expect(b.testsBounded).toBe(a.testsBounded);
    } finally { closeA(); closeB(); }
  });

  it('provenance arrays remain sorted ascending in the streamed path', async () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      seedFixture(db, 6);
      await derive({
        db,
        params: { maxDepth: 10, maxMillisPerTest: 5000, threshold: 0, hookStopList: new Set() },
        clock: systemClock,
        workers: 2,
      });
      const rows = db.prepare('SELECT provenance FROM edge').all() as Array<{ provenance: string }>;
      for (const r of rows) {
        const arr = JSON.parse(r.provenance) as number[];
        const sorted = [...arr].sort((a, b) => a - b);
        expect(arr).toEqual(sorted);
        // dedup invariant
        expect(new Set(arr).size).toEqual(arr.length);
      }
    } finally { close(); }
  });
});
