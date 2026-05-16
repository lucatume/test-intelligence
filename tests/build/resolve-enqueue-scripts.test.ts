import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor } from '../../src/store/writers.js';
import { resolveEnqueueScripts } from '../../src/build/resolve-enqueue-scripts.js';

const NOW = '2026-05-16T00:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyInitialSchema(db);
  return db;
}

function addFile(db: Database.Database, path: string): number {
  return upsertFile(db, {
    path, language: 'js', contentHash: 'h', extractedAt: NOW,
    isTest: false, framework: null, frameworkClass: null,
  });
}

function addEnqueueFact(db: Database.Database, fileId: number, jsPath: string): number {
  const factId = insertFact(db, {
    fileId, kind: 'enqueue-script', resolved: true, startLine: 1, endLine: 1,
    payload: { kind: 'enqueue-script', srcPath: jsPath },
  });
  const anchorId = upsertAnchor(db, { key: 'js-module:' + jsPath, type: 'js-module' });
  insertFactAnchor(db, { factId, anchorId, role: 'target' });
  return factId;
}

function anchorKeyOf(db: Database.Database, factId: number): string {
  const row = db.prepare(
    `SELECT a.key AS key FROM fact_anchor fa
     JOIN anchor a ON a.id = fa.anchor_id
     WHERE fa.fact_id = ? AND fa.role = 'target' AND a.type = 'js-module'`,
  ).get(factId) as { key: string };
  return row.key;
}

describe('resolveEnqueueScripts', () => {
  it('repoints a .min.js js-module anchor to the un-minified file', () => {
    const db = freshDb();
    const enqFile = addFile(db, 'assets/js/admin/foo.php');
    addFile(db, 'assets/js/admin/quick-edit.js');
    const factId = addEnqueueFact(db, enqFile, 'assets/js/admin/quick-edit.min.js');

    const summary = resolveEnqueueScripts(db, { outputDirs: ['build', 'dist'] });

    expect(summary.repointed).toBe(1);
    expect(anchorKeyOf(db, factId)).toBe('js-module:assets/js/admin/quick-edit.js');
    db.close();
  });

  it('leaves an anchor that already names an extant file untouched', () => {
    const db = freshDb();
    const enqFile = addFile(db, 'plugin.php');
    addFile(db, 'src/admin.js');
    const factId = addEnqueueFact(db, enqFile, 'src/admin.js');

    const summary = resolveEnqueueScripts(db, { outputDirs: ['build', 'dist'] });

    expect(summary.repointed).toBe(0);
    expect(anchorKeyOf(db, factId)).toBe('js-module:src/admin.js');
    db.close();
  });

  it('repoints a build/ bundle to src/ when an *.asset.php sibling exists', () => {
    const db = freshDb();
    const enqFile = addFile(db, 'plugin.php');
    addFile(db, 'build/index.js');
    addFile(db, 'build/index.asset.php');
    addFile(db, 'src/index.tsx');
    const factId = addEnqueueFact(db, enqFile, 'build/index.js');

    const summary = resolveEnqueueScripts(db, { outputDirs: ['build', 'dist'] });

    expect(summary.repointed).toBe(1);
    expect(anchorKeyOf(db, factId)).toBe('js-module:src/index.tsx');
    db.close();
  });

  it('leaves an unresolvable compiled path untouched and counts it examined', () => {
    const db = freshDb();
    const enqFile = addFile(db, 'plugin.php');
    const factId = addEnqueueFact(db, enqFile, 'build/index.js'); // no src/, no .asset.php

    const summary = resolveEnqueueScripts(db, { outputDirs: ['build', 'dist'] });

    expect(summary.repointed).toBe(0);
    expect(summary.examined).toBe(1);
    expect(anchorKeyOf(db, factId)).toBe('js-module:build/index.js');
    db.close();
  });
});

function addSrcSkeletonFact(db: Database.Database, fileId: number, srcSkel: string): number {
  // An enqueue-script fact carrying ONLY a script-handle anchor, with a {*}
  // src skeleton (the WC()->plugin_url() . '/assets/js/...' . $suffix idiom).
  const factId = insertFact(db, {
    fileId, kind: 'enqueue-script', resolved: false, startLine: 1, endLine: 1,
    payload: { kind: 'enqueue-script', handle: 'h', src: srcSkel },
  });
  const anchorId = upsertAnchor(db, { key: 'script-handle:h', type: 'script-handle' });
  insertFactAnchor(db, { factId, anchorId, role: 'subject' });
  return factId;
}

describe('resolveEnqueueScripts — src-skeleton suffix resolution', () => {
  it('resolves a {*}-prefixed src skeleton by suffix match against the file set', () => {
    const db = freshDb();
    const enqFile = addFile(db, 'includes/admin/class-wc-admin-brands.php');
    addFile(db, 'assets/js/admin/wc-brands-enhanced-select.js');
    // src skeleton: WC()->plugin_url() . '/assets/js/admin/wc-...' . $suffix . '.js'
    const factId = addSrcSkeletonFact(db, enqFile, '{*}/assets/js/admin/wc-brands-enhanced-select{*}.js');

    const summary = resolveEnqueueScripts(db, { outputDirs: ['build', 'dist'] });

    expect(summary.skeletonResolved).toBe(1);
    expect(anchorKeyOf(db, factId)).toBe('js-module:assets/js/admin/wc-brands-enhanced-select.js');
    db.close();
  });

  it('leaves a CSS src skeleton alone (no JS file to bridge)', () => {
    const db = freshDb();
    const enqFile = addFile(db, 'plugin.php');
    const factId = addSrcSkeletonFact(db, enqFile, '{*}/assets/css/admin.css');
    const summary = resolveEnqueueScripts(db, { outputDirs: ['build', 'dist'] });
    expect(summary.skeletonResolved).toBe(0);
    const row = db.prepare(
      `SELECT count(*) AS n FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
       WHERE fa.fact_id = ? AND a.type = 'js-module'`,
    ).get(factId) as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });

  it('does not resolve an ambiguous suffix that matches two files', () => {
    const db = freshDb();
    const enqFile = addFile(db, 'plugin.php');
    addFile(db, 'assets/js/foo.js');
    addFile(db, 'vendor/pkg/assets/js/foo.js');
    const factId = addSrcSkeletonFact(db, enqFile, '{*}/assets/js/foo.js');
    const summary = resolveEnqueueScripts(db, { outputDirs: ['build', 'dist'] });
    expect(summary.skeletonResolved).toBe(0);
    const row = db.prepare(
      `SELECT count(*) AS n FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
       WHERE fa.fact_id = ? AND a.type = 'js-module'`,
    ).get(factId) as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });
});
