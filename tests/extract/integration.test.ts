import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { walk } from '../../src/discover/walk.js';
import { extractFile } from '../../src/extract/index.js';
import { synthesizeCompilerOptions } from '../../src/extract/ts/compiler.js';
import { parseConfig } from '../../src/config/parse.js';
import { openStore } from '../../src/store/open.js';
import {
  upsertFile,
  insertFact,
  upsertAnchor,
  insertFactAnchor,
  insertTest,
} from '../../src/store/writers.js';
import { parseAnchor } from '../../src/anchors/parse.js';
import { useTmpDir } from '../helpers/tmpDir.js';

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const TS_FIXTURE = `
import { addItem } from './cart';
import './style.css';
describe('Cart', () => {
  it('adds items', () => { addItem(); });
});
`;

const CART_FIXTURE = `export function addItem() { return 1; }`;

describe('discover + extract + store integration', () => {
  const getTmp = useTmpDir('ti-integration-');

  it('persists facts, anchors, and a test row end-to-end', async () => {
    const root = getTmp();
    write(root, 'src/cart.ts', CART_FIXTURE);
    write(root, 'tests/cart.test.ts', TS_FIXTURE);

    const cfgRes = parseConfig({});
    if (cfgRes.kind === 'err') throw new Error('config');
    const cfg = cfgRes.value;
    const opts = synthesizeCompilerOptions(root);

    const storeRes = openStore(root);
    if (storeRes.kind === 'err') throw new Error(storeRes.error.message);
    const { db, close } = storeRes.value;
    try {
      for await (const file of walk(root, cfg)) {
        const source = readFileSync(join(root, file.path), 'utf8');
        const hash = createHash('sha1').update(source).digest('hex');
        const fileId = upsertFile(db, {
          path: file.path,
          language: file.language,
          contentHash: hash,
          extractedAt: '2026-05-13T00:00:00.000Z',
          isTest: file.framework !== null,
          framework: file.framework,
          frameworkClass: file.frameworkClass,
        });
        const facts = await extractFile({
          projectRoot: root,
          path: file.path,
          language: file.language,
          framework: file.framework,
          compilerOptions: opts,
          patterns: [],
        });
        if (facts.kind === 'err') throw new Error(facts.error.message);
        for (const f of facts.value) {
          const factId = insertFact(db, {
            fileId,
            kind: f.kind,
            resolved: f.resolved,
            startLine: f.location.startLine,
            endLine: f.location.endLine,
            payload: f.payload,
          });
          for (const a of f.anchors) {
            const parsed = parseAnchor(a.key);
            if (parsed.kind === 'err') continue;
            const anchorId = upsertAnchor(db, { key: parsed.value.key, type: parsed.value.type });
            insertFactAnchor(db, { factId, anchorId, role: a.role });
          }
          if (f.kind === 'test-def') {
            const payload = f.payload as { testId: string; framework: string };
            insertTest(db, {
              testId: payload.testId,
              fileId,
              framework: payload.framework,
              frameworkClass: file.frameworkClass ?? 'unit',
              factId,
            });
          }
        }
      }

      const fileCount = (db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number }).n;
      const factCount = (db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number }).n;
      const testCount = (db.prepare('SELECT COUNT(*) AS n FROM test').get() as { n: number }).n;
      const anchorCount = (db.prepare('SELECT COUNT(*) AS n FROM anchor').get() as { n: number }).n;

      expect(fileCount).toBe(2);
      expect(factCount).toBeGreaterThanOrEqual(4);
      expect(testCount).toBeGreaterThanOrEqual(1);
      expect(anchorCount).toBeGreaterThanOrEqual(2);
    } finally { close(); }
  });
});
