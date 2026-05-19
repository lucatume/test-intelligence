import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runJsResolve } from '../../src/jsresolve/index.js';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor } from '../../src/store/writers.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const EPOCH = '2026-05-19T00:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyInitialSchema(db);
  return db;
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

    it('resolves a cross-file apiFetch path and leaves a dynamic caller untouched', () => {
      const root = getTmp();

      // Fixture: cfg.js exports the path constant; caller.js imports and calls apiFetch
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/cfg.js'), `export const PRODUCTS_PATH = '/wc/v3/products';\n`);
      writeFileSync(
        join(root, 'src/caller.js'),
        `import { PRODUCTS_PATH } from './cfg.js';\napiFetch({ path: PRODUCTS_PATH });\n`,
      );
      // Dynamic caller — arg is a runtime variable, cannot be resolved
      writeFileSync(
        join(root, 'src/dynamic.js'),
        `apiFetch({ path: window.dynamicPath });\n`,
      );

      const db = freshDb();

      // Seed the file row for the resolvable caller
      const callerFileId = upsertFile(db, {
        path: 'src/caller.js',
        language: 'js',
        contentHash: 'a'.repeat(64),
        extractedAt: EPOCH,
        isTest: false,
        framework: null,
        frameworkClass: null,
      });

      // Seed the unresolved rest-call-js fact for the apiFetch call (line 2)
      const resolvedFactId = insertFact(db, {
        fileId: callerFileId,
        kind: 'rest-call-js',
        resolved: false,
        startLine: 2,
        endLine: 2,
        payload: {
          kind: 'rest-call-js',
          method: 'GET',
          route: '{*}',
          unresolved: {
            scope: '(file)',
            fields: [{ field: 'config', expression: '{ path: PRODUCTS_PATH }' }],
            exprHash: 'abc123',
          },
        },
      });

      // Seed the placeholder anchor for the unresolved fact
      const placeholderAnchorId = upsertAnchor(db, { key: 'rest:GET {*}', type: 'rest' });
      insertFactAnchor(db, { factId: resolvedFactId, anchorId: placeholderAnchorId, role: 'target' });

      // Seed file and fact for the dynamic caller
      const dynamicFileId = upsertFile(db, {
        path: 'src/dynamic.js',
        language: 'js',
        contentHash: 'b'.repeat(64),
        extractedAt: EPOCH,
        isTest: false,
        framework: null,
        frameworkClass: null,
      });
      const dynamicFactId = insertFact(db, {
        fileId: dynamicFileId,
        kind: 'rest-call-js',
        resolved: false,
        startLine: 1,
        endLine: 1,
        payload: {
          kind: 'rest-call-js',
          method: 'GET',
          route: '{*}',
          unresolved: {
            scope: '(file)',
            fields: [{ field: 'config', expression: '{ path: window.dynamicPath }' }],
            exprHash: 'def456',
          },
        },
      });
      const dynamicAnchorId = upsertAnchor(db, { key: 'rest:GET {*}', type: 'rest' });
      insertFactAnchor(db, { factId: dynamicFactId, anchorId: dynamicAnchorId, role: 'target' });

      const summary = runJsResolve(db, { projectRoot: root });

      // Both facts were examined; only one resolved
      expect(summary).toEqual({ examined: 2, resolved: 1 });

      // The resolvable fact is now resolved=1
      const resolvedRow = db
        .prepare('SELECT resolved, payload FROM fact WHERE id = ?')
        .get(resolvedFactId) as { resolved: number; payload: string };
      expect(resolvedRow.resolved).toBe(1);
      const resolvedPayload = JSON.parse(resolvedRow.payload) as Record<string, unknown>;
      expect(resolvedPayload['route']).toBe('/wc/v3/products');
      expect((resolvedPayload['meta'] as Record<string, unknown>)['resolvedBy']).toBe('js-interprocedural');
      expect(resolvedPayload['unresolved']).toBeUndefined();

      // The anchor is now the resolved key, not the placeholder
      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ? AND fa.role = 'target'`,
          )
          .all(resolvedFactId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toEqual(['rest:GET /wc/v3/products']);

      // The dynamic fact is still unresolved
      const dynamicRow = db
        .prepare('SELECT resolved FROM fact WHERE id = ?')
        .get(dynamicFactId) as { resolved: number };
      expect(dynamicRow.resolved).toBe(0);

      db.close();
    });
  });
});
