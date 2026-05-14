import { describe, it, expect } from 'vitest';
import { openStore } from '../../../src/store/open.js';
import {
  upsertFile, insertFact, insertEdge, insertTest,
} from '../../../src/store/writers.js';
import { explainCommand } from '../../../src/cli/commands/explain.js';
import { useTmpDir } from '../../helpers/tmpDir.js';
import { makeIo } from '../_helpers/makeIo.js';

describe('explainCommand', () => {
  const getTmp = useTmpDir('ti-explain-');

  function seed(root: string) {
    const s = openStore(root);
    if (s.kind === 'err') throw new Error(s.error.message);
    const { db, close } = s.value;
    const fId = upsertFile(db, {
      path: 'src/cart.ts', language: 'ts', contentHash: 'h',
      extractedAt: 't', isTest: false, framework: null, frameworkClass: null,
    });
    const tFileId = upsertFile(db, {
      path: 'tests/cart.test.ts', language: 'ts', contentHash: 'h',
      extractedAt: 't', isTest: true, framework: 'jest', frameworkClass: 'unit',
    });
    const sFact = insertFact(db, {
      fileId: fId, kind: 'symbol-def', resolved: true, startLine: 3, endLine: 3,
      payload: { kind: 'symbol-def', name: 'addItem', exported: true },
    });
    const tFact = insertFact(db, {
      fileId: tFileId, kind: 'test-def', resolved: true, startLine: 1, endLine: 1,
      payload: { kind: 'test-def', framework: 'jest', testId: 'jest:tests/cart.test.ts::adds' },
    });
    insertTest(db, {
      testId: 'jest:tests/cart.test.ts::adds', fileId: tFileId,
      framework: 'jest', frameworkClass: 'unit', factId: tFact,
    });
    insertEdge(db, {
      testId: 'jest:tests/cart.test.ts::adds', source: 'src/cart.ts',
      confidence: 0.9, partial: false, evidence: [], derivedAt: 't',
      provenance: [sFact],
    });
    close();
  }

  it('prints evidence trail for a test id', () => {
    const root = getTmp();
    seed(root);
    const t = makeIo();
    const code = explainCommand({
      projectRoot: root,
      io: t.io,
      target: 'jest:tests/cart.test.ts::adds',
      format: 'args',
    });
    expect(code).toBe(0);
    expect(t.out).toContain('jest:tests/cart.test.ts::adds <- src/cart.ts');
    expect(t.out).toContain('src/cart.ts:3 symbol-def');
  });

  it('emits structured JSON with evidence factKinds', () => {
    const root = getTmp();
    seed(root);
    const t = makeIo();
    const code = explainCommand({
      projectRoot: root,
      io: t.io,
      target: 'src/cart.ts',
      format: 'json',
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(t.out) as { edges: { evidence: { factKind: string }[] }[] };
    expect(parsed.edges[0]?.evidence[0]?.factKind).toBe('symbol-def');
  });

  it('exits 0 with stderr notice when target has no edges', () => {
    const root = getTmp();
    seed(root);
    const t = makeIo();
    const code = explainCommand({
      projectRoot: root,
      io: t.io,
      target: 'tests/missing.test.ts',
      format: 'args',
    });
    expect(code).toBe(0);
    expect(t.err).toContain('no edges found');
  });
});
