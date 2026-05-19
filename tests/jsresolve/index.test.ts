import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runJsResolve } from '../../src/jsresolve/index.js';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor } from '../../src/store/writers.js';
import { extractTsFile } from '../../src/extract/ts/extract.js';
import { synthesizeCompilerOptions } from '../../src/extract/ts/compiler.js';
import { WP_JS_PATTERNS } from '../../src/extract/declarative/wp-js-patterns.js';
import type { Fact } from '../../src/facts/types.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const EPOCH = '2026-05-19T00:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyInitialSchema(db);
  return db;
}

// Insert one extracted fact (file row + fact row + its anchors) into the
// store using the real writers, mirroring runBuild's per-file path.
function seedFact(db: Database.Database, relPath: string, fact: Fact): number {
  const fileId = upsertFile(db, {
    path: relPath,
    language: 'js',
    contentHash: 'a'.repeat(64),
    extractedAt: EPOCH,
    isTest: false,
    framework: null,
    frameworkClass: null,
  });
  const factId = insertFact(db, {
    fileId,
    kind: fact.kind,
    resolved: fact.resolved,
    startLine: fact.location.startLine,
    endLine: fact.location.endLine,
    payload: fact.payload,
  });
  for (const a of fact.anchors) {
    const anchorId = upsertAnchor(db, { key: a.key, type: a.key.split(':')[0] ?? '' });
    insertFactAnchor(db, { factId, anchorId, role: a.role });
  }
  return factId;
}

describe('runJsResolve', () => {
  it('returns a zero summary for a store with no unresolved caller facts', () => {
    const db = new Database(':memory:');
    applyInitialSchema(db);
    const summary = runJsResolve(db, { projectRoot: '/nonexistent' });
    expect(summary).toEqual({ examined: 0, resolved: 0 });
  });

  describe('resolves unresolved rest-call-js facts interprocedurally', () => {
    const getTmp = useTmpDir('ti-jsresolve-idx-');

    it('resolves a cross-file apiFetch path and leaves a dynamic caller untouched', async () => {
      const root = getTmp();

      // Fixture: cfg.js exports the path constant; caller.js imports and calls
      // apiFetch with it. dynamic.js calls apiFetch with a runtime variable.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/cfg.js'), `export const PRODUCTS_PATH = '/wc/v3/products';\n`);
      writeFileSync(
        join(root, 'src/caller.js'),
        `import { PRODUCTS_PATH } from './cfg.js';\napiFetch({ path: PRODUCTS_PATH });\n`,
      );
      writeFileSync(
        join(root, 'src/dynamic.js'),
        `apiFetch({ path: window.dynamicPath });\n`,
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);

      // Run ti's REAL extraction over the fixtures and seed the resulting
      // facts — not hand-written shapes — so the test exercises what ti emits.
      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const dynamicFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/dynamic.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });

      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      const dynamicRest = dynamicFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      expect(dynamicRest).toBeDefined();
      if (callerRest === undefined || dynamicRest === undefined) return;

      // Sanity-check the real extractor shape: unresolved, no anchors.
      expect(callerRest.resolved).toBe(false);
      expect(callerRest.anchors).toEqual([]);

      const resolvedFactId = seedFact(db, 'src/caller.js', callerRest);
      const dynamicFactId = seedFact(db, 'src/dynamic.js', dynamicRest);

      const summary = runJsResolve(db, { projectRoot: root });

      // Both facts were examined; only one resolved.
      expect(summary).toEqual({ examined: 2, resolved: 1 });

      // The resolvable fact is now resolved=1.
      const resolvedRow = db
        .prepare('SELECT resolved, payload FROM fact WHERE id = ?')
        .get(resolvedFactId) as { resolved: number; payload: string };
      expect(resolvedRow.resolved).toBe(1);
      const resolvedPayload = JSON.parse(resolvedRow.payload) as Record<string, unknown>;
      expect(resolvedPayload['route']).toBe('/wc/v3/products');
      expect((resolvedPayload['meta'] as Record<string, unknown>)['resolvedBy']).toBe('js-interprocedural');
      expect(resolvedPayload['unresolved']).toBeUndefined();

      // A fresh fact_anchor row to a PHP-listener-shaped key was inserted.
      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ? AND fa.role = 'target'`,
          )
          .all(resolvedFactId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toEqual(['rest:GET /wc/v3/products']);

      // The dynamic fact is still unresolved.
      const dynamicRow = db
        .prepare('SELECT resolved FROM fact WHERE id = ?')
        .get(dynamicFactId) as { resolved: number };
      expect(dynamicRow.resolved).toBe(0);

      db.close();
    });
  });
});
