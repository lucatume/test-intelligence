import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';
import { upsertFile, insertFact } from '../../src/store/writers.js';
import { resolveBlockJson } from '../../src/build/resolve-block-json.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const EPOCH = '2026-05-17T00:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyInitialSchema(db);
  return db;
}

function fileRow(db: Database.Database, path: string): number {
  return upsertFile(db, {
    path,
    language: 'php',
    contentHash: 'h'.repeat(64),
    extractedAt: EPOCH,
    isTest: false,
    framework: null,
    frameworkClass: null,
  });
}

// Insert an unresolved block-render fact carrying `payload`; returns fact id.
function insertBlockRender(
  db: Database.Database,
  payload: Record<string, unknown>,
  path = 'loader.php',
): number {
  const fileId = fileRow(db, path);
  return insertFact(db, {
    fileId,
    kind: 'block-render',
    resolved: false,
    startLine: 1,
    endLine: 1,
    payload: { kind: 'block-render', ...payload },
  });
}

function anchorKeysFor(db: Database.Database, factId: number): string[] {
  return (
    db
      .prepare(
        `SELECT a.key AS key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
         WHERE fa.fact_id = ? AND fa.role = 'subject'`,
      )
      .all(factId) as { key: string }[]
  ).map((r) => r.key);
}

describe('resolveBlockJson', () => {
  const getTmp = useTmpDir('ti-block-json-');

  it('resolves a fact whose dir holds a block.json with a name', () => {
    const root = getTmp();
    mkdirSync(join(root, 'blocks/paragraph'), { recursive: true });
    writeFileSync(
      join(root, 'blocks/paragraph/block.json'),
      JSON.stringify({ name: 'core/paragraph' }),
    );
    const db = freshDb();
    const factId = insertBlockRender(db, { dir: 'blocks/paragraph' });

    const summary = resolveBlockJson(db, { projectRoot: root });

    expect(summary).toEqual({ examined: 1, resolved: 1 });
    const fact = db.prepare(`SELECT resolved, payload FROM fact WHERE id = ?`).get(factId) as {
      resolved: number;
      payload: string;
    };
    expect(fact.resolved).toBe(1);
    expect(JSON.parse(fact.payload)).toMatchObject({
      kind: 'block-render',
      name: 'core/paragraph',
      dir: 'blocks/paragraph',
    });
    expect(anchorKeysFor(db, factId)).toEqual(['block:core/paragraph']);
    db.close();
  });

  it('accepts a dir that points directly at a block.json file', () => {
    const root = getTmp();
    mkdirSync(join(root, 'blocks/quote'), { recursive: true });
    writeFileSync(join(root, 'blocks/quote/block.json'), JSON.stringify({ name: 'core/quote' }));
    const db = freshDb();
    const factId = insertBlockRender(db, { dir: 'blocks/quote/block.json' });

    expect(resolveBlockJson(db, { projectRoot: root })).toEqual({ examined: 1, resolved: 1 });
    expect(anchorKeysFor(db, factId)).toEqual(['block:core/quote']);
    db.close();
  });

  it('leaves the fact unresolved when block.json is missing', () => {
    const root = getTmp();
    const db = freshDb();
    const factId = insertBlockRender(db, { dir: 'blocks/absent' });

    expect(resolveBlockJson(db, { projectRoot: root })).toEqual({ examined: 1, resolved: 0 });
    const fact = db.prepare(`SELECT resolved FROM fact WHERE id = ?`).get(factId) as {
      resolved: number;
    };
    expect(fact.resolved).toBe(0);
    expect(anchorKeysFor(db, factId)).toEqual([]);
    db.close();
  });

  it('leaves the fact unresolved when block.json is invalid JSON', () => {
    const root = getTmp();
    mkdirSync(join(root, 'blocks/bad'), { recursive: true });
    writeFileSync(join(root, 'blocks/bad/block.json'), '{ not json');
    const db = freshDb();
    insertBlockRender(db, { dir: 'blocks/bad' });

    expect(resolveBlockJson(db, { projectRoot: root })).toEqual({ examined: 1, resolved: 0 });
    db.close();
  });

  it('leaves the fact unresolved when name is missing or not a non-empty string', () => {
    const root = getTmp();
    mkdirSync(join(root, 'blocks/noname'), { recursive: true });
    writeFileSync(join(root, 'blocks/noname/block.json'), JSON.stringify({ title: 'No name' }));
    mkdirSync(join(root, 'blocks/emptyname'), { recursive: true });
    writeFileSync(join(root, 'blocks/emptyname/block.json'), JSON.stringify({ name: '' }));
    const db = freshDb();
    insertBlockRender(db, { dir: 'blocks/noname' }, 'a.php');
    insertBlockRender(db, { dir: 'blocks/emptyname' }, 'b.php');

    expect(resolveBlockJson(db, { projectRoot: root })).toEqual({ examined: 2, resolved: 0 });
    db.close();
  });

  it('ignores facts with no dir field and already-resolved facts', () => {
    const root = getTmp();
    const db = freshDb();
    insertBlockRender(db, {}, 'nodir.php'); // no dir
    const fileId = fileRow(db, 'done.php');
    insertFact(db, {
      fileId,
      kind: 'block-render',
      resolved: true,
      startLine: 1,
      endLine: 1,
      payload: { kind: 'block-render', name: 'core/done', dir: 'x' },
    });

    expect(resolveBlockJson(db, { projectRoot: root })).toEqual({ examined: 0, resolved: 0 });
    db.close();
  });
});
