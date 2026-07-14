import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store/open.js';
import {
  upsertFile,
  insertFact,
  upsertAnchor,
  insertFactAnchor,
  insertTest,
  clearFactsForFile,
  updateFactResolvedPayload,
  repointFactAnchor,
  upsertResolution,
  readResolution,
  pruneStaleResolutions,
} from '../../src/store/writers.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('store writers', () => {
  const getTmp = useTmpDir('ti-store-writers-');

  it('upsertFile is idempotent on path', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const id1 = upsertFile(db, {
        path: 'src/a.ts', language: 'ts', contentHash: 'h1',
        extractedAt: '2026-05-13T00:00:00.000Z',
        isTest: false, framework: null, frameworkClass: null,
      });
      const id2 = upsertFile(db, {
        path: 'src/a.ts', language: 'ts', contentHash: 'h2',
        extractedAt: '2026-05-13T00:00:01.000Z',
        isTest: false, framework: null, frameworkClass: null,
      });
      expect(id1).toBe(id2);
      const row = db.prepare('SELECT content_hash FROM file WHERE id = ?').get(id1) as { content_hash: string };
      expect(row.content_hash).toBe('h2');
    } finally { close(); }
  });

  it('insertFact + upsertAnchor + insertFactAnchor link rows', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const fileId = upsertFile(db, {
        path: 'src/cart.ts', language: 'ts', contentHash: 'h',
        extractedAt: '2026-05-13T00:00:00.000Z',
        isTest: false, framework: null, frameworkClass: null,
      });
      const factId = insertFact(db, {
        fileId, kind: 'symbol-def', resolved: true,
        startLine: 1, endLine: 1,
        payload: { kind: 'symbol-def', name: 'addItem', exported: true },
      });
      const anchorId = upsertAnchor(db, { key: 'js-symbol:src/cart.ts:addItem', type: 'js-symbol' });
      insertFactAnchor(db, { factId, anchorId, role: 'subject' });
      const row = db.prepare(`
        SELECT a.key, fa.role FROM fact_anchor fa
        JOIN anchor a ON a.id = fa.anchor_id
        WHERE fa.fact_id = ?
      `).get(factId) as { key: string; role: string };
      expect(row.key).toBe('js-symbol:src/cart.ts:addItem');
      expect(row.role).toBe('subject');
    } finally { close(); }
  });

  it('insertTest requires file_id + fact_id', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const fileId = upsertFile(db, {
        path: 'tests/cart.test.ts', language: 'ts', contentHash: 'h',
        extractedAt: '2026-05-13T00:00:00.000Z',
        isTest: true, framework: 'jest', frameworkClass: 'unit',
      });
      const factId = insertFact(db, {
        fileId, kind: 'test-def', resolved: true,
        startLine: 5, endLine: 5,
        payload: { kind: 'test-def', framework: 'jest', testId: 'jest:tests/cart.test.ts::adds items' },
      });
      insertTest(db, {
        testId: 'jest:tests/cart.test.ts::adds items',
        fileId, framework: 'jest', frameworkClass: 'unit', factId,
      });
      const t = db.prepare('SELECT test_id FROM test').get() as { test_id: string };
      expect(t.test_id).toBe('jest:tests/cart.test.ts::adds items');
    } finally { close(); }
  });

  it('clearFactsForFile deletes all fact rows for the given file id only', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const fileA = upsertFile(db, {
        path: 'ti_deletemeelephant_a.php', language: 'php', contentHash: 'h1',
        extractedAt: '2026-05-15T00:00:00.000Z', isTest: false, framework: null, frameworkClass: null,
      });
      const fileB = upsertFile(db, {
        path: 'ti_deletemeelephant_b.php', language: 'php', contentHash: 'h2',
        extractedAt: '2026-05-15T00:00:00.000Z', isTest: false, framework: null, frameworkClass: null,
      });
      insertFact(db, { fileId: fileA, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: {} });
      insertFact(db, { fileId: fileA, kind: 'symbol-def', resolved: true, startLine: 2, endLine: 2, payload: {} });
      insertFact(db, { fileId: fileB, kind: 'symbol-def', resolved: true, startLine: 1, endLine: 1, payload: {} });

      clearFactsForFile(db, fileA);

      const a = db.prepare('SELECT COUNT(*) AS n FROM fact WHERE file_id = ?').get(fileA) as { n: number };
      const b = db.prepare('SELECT COUNT(*) AS n FROM fact WHERE file_id = ?').get(fileB) as { n: number };
      expect(a.n).toBe(0);
      expect(b.n).toBe(1);
    } finally { close(); }
  });

  it('updateFactResolvedPayload updates resolved and payload of a fact', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const fileId = upsertFile(db, {
        path: 'p.php', language: 'php', contentHash: 'h',
        extractedAt: '2026-05-15T00:00:00.000Z', isTest: false, framework: null, frameworkClass: null,
      });
      const factId = insertFact(db, {
        fileId, kind: 'rest-endpoint', resolved: false, startLine: 1, endLine: 1,
        payload: { kind: 'rest-endpoint', method: 'GET', route: '/x', namespace: '{*}' },
      });
      updateFactResolvedPayload(db, {
        factId, resolved: true,
        payload: { kind: 'rest-endpoint', method: 'GET', route: '/x', namespace: 'wp/v2' },
      });
      const row = db.prepare('SELECT resolved, payload FROM fact WHERE id = ?').get(factId) as { resolved: number; payload: string };
      expect(row.resolved).toBe(1);
      expect(JSON.parse(row.payload)).toMatchObject({ namespace: 'wp/v2' });
    } finally { close(); }
  });

  it('repointFactAnchor replaces a fact_anchor row with a new anchor', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      const fileId = upsertFile(db, {
        path: 'p.php', language: 'php', contentHash: 'h',
        extractedAt: '2026-05-15T00:00:00.000Z', isTest: false, framework: null, frameworkClass: null,
      });
      const factId = insertFact(db, {
        fileId, kind: 'rest-endpoint', resolved: false, startLine: 1, endLine: 1,
        payload: { kind: 'rest-endpoint', method: 'GET', route: '/x', namespace: '{*}' },
      });
      const oldAnchor = upsertAnchor(db, { key: 'rest:GET /{*}/x', type: 'rest' });
      insertFactAnchor(db, { factId, anchorId: oldAnchor, role: 'subject' });
      const newAnchor = upsertAnchor(db, { key: 'rest:GET /wp/v2/x', type: 'rest' });
      repointFactAnchor(db, { factId, oldAnchorId: oldAnchor, newAnchorId: newAnchor, role: 'subject' });
      const rows = db.prepare('SELECT anchor_id FROM fact_anchor WHERE fact_id = ?').all(factId) as Array<{ anchor_id: number }>;
      expect(rows).toEqual([{ anchor_id: newAnchor }]);
    } finally { close(); }
  });
});

describe('resolution writers', () => {
  const getTmp = useTmpDir('ti-resolution-writers-');

  it('upsertResolution + readResolution round-trip and replace on conflict', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      upsertResolution(db, {
        exprHash: 'h1', pass: 'llm', resolvedValue: { hookName: 'save_post' },
        classification: 'structural-rule', citePath: 'a.php', citeLine: 10,
        citeVerified: true, importedAt: '2026-05-17T00:00:00.000Z',
      });
      const first = readResolution(db, 'h1', 'llm');
      expect(first?.classification).toBe('structural-rule');
      expect(first?.resolvedValue).toEqual({ hookName: 'save_post' });
      expect(first?.citeVerified).toBe(true);

      upsertResolution(db, {
        exprHash: 'h1', pass: 'llm', resolvedValue: { hookName: 'save_post' },
        classification: 'project-constant', citePath: 'a.php', citeLine: 11,
        citeVerified: true, importedAt: '2026-05-17T00:00:01.000Z',
      });
      expect(readResolution(db, 'h1', 'llm')?.classification).toBe('project-constant');
    } finally { close(); }
  });

  it('readResolution returns null for an absent row', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      expect(readResolution(db, 'missing', 'llm')).toBeNull();
    } finally { close(); }
  });

  it('pruneStaleResolutions deletes rows whose expr_hash is not live', () => {
    const s = openStore(getTmp());
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    try {
      upsertResolution(db, { exprHash: 'live', pass: 'llm', resolvedValue: {},
        classification: 'data-dependent-unresolvable', citePath: '', citeLine: 0,
        citeVerified: false, importedAt: '2026-05-17T00:00:00.000Z' });
      upsertResolution(db, { exprHash: 'dead', pass: 'llm', resolvedValue: {},
        classification: 'data-dependent-unresolvable', citePath: '', citeLine: 0,
        citeVerified: false, importedAt: '2026-05-17T00:00:00.000Z' });
      const removed = pruneStaleResolutions(db, new Set(['live']));
      expect(removed).toBe(1);
      expect(readResolution(db, 'live', 'llm')).not.toBeNull();
      expect(readResolution(db, 'dead', 'llm')).toBeNull();
    } finally { close(); }
  });
});
