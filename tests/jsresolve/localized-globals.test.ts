import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor } from '../../src/store/writers.js';
import { buildLocalizedGlobals } from '../../src/jsresolve/localized-globals.js';

const EPOCH = '2026-05-19T00:00:00.000Z';

function seed(opts: { enqueue?: boolean } = {}): Database.Database {
  const enqueue = opts.enqueue ?? true;
  const db = new Database(':memory:');
  applyInitialSchema(db);

  const phpFileId = upsertFile(db, {
    path: 'plugin.php',
    language: 'php',
    contentHash: 'a'.repeat(64),
    extractedAt: EPOCH,
    isTest: false,
    framework: null,
    frameworkClass: null,
  });

  upsertFile(db, {
    path: 'assets/app.js',
    language: 'js',
    contentHash: 'b'.repeat(64),
    extractedAt: EPOCH,
    isTest: false,
    framework: null,
    frameworkClass: null,
  });

  // script-localize fact: handle=app, objectName=wcSettings, data={action:'do_thing'}
  const localizeFactId = insertFact(db, {
    fileId: phpFileId,
    kind: 'script-localize',
    resolved: true,
    startLine: 10,
    endLine: 10,
    payload: {
      kind: 'script-localize',
      handle: 'app',
      objectName: 'wcSettings',
      data: { action: 'do_thing' },
    },
  });

  const localizeAnchorId = upsertAnchor(db, { key: 'script-handle:app', type: 'script-handle' });
  insertFactAnchor(db, { factId: localizeFactId, anchorId: localizeAnchorId, role: 'subject' });

  // enqueue-script fact: links handle=app to js-module:assets/app.js
  if (enqueue) {
    const enqueueFactId = insertFact(db, {
      fileId: phpFileId,
      kind: 'enqueue-script',
      resolved: true,
      startLine: 5,
      endLine: 5,
      payload: { kind: 'enqueue-script', handle: 'app' },
    });

    insertFactAnchor(db, { factId: enqueueFactId, anchorId: localizeAnchorId, role: 'subject' });

    const jsModuleAnchorId = upsertAnchor(db, {
      key: 'js-module:assets/app.js',
      type: 'js-module',
    });
    insertFactAnchor(db, { factId: enqueueFactId, anchorId: jsModuleAnchorId, role: 'target' });
  }

  return db;
}

describe('buildLocalizedGlobals', () => {
  it('resolves <object>.<key> for a file enqueued under the localizing handle', () => {
    const idx = buildLocalizedGlobals(seed());
    expect(idx.lookup('wcSettings', 'assets/app.js')).toEqual({ action: 'do_thing' });
  });

  it('does not resolve for a file not enqueued under that handle', () => {
    const idx = buildLocalizedGlobals(seed());
    expect(idx.lookup('wcSettings', 'assets/other.js')).toBe(null);
  });

  it('resolves unconditionally when the handle has no enqueue-script facts', () => {
    const idx = buildLocalizedGlobals(seed({ enqueue: false }));
    expect(idx.lookup('wcSettings', 'assets/anything.js')).toEqual({ action: 'do_thing' });
  });
});
