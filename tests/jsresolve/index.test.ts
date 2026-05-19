import { describe, it, expect } from 'vitest';
import { runJsResolve } from '../../src/jsresolve/index.js';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';

describe('runJsResolve', () => {
  it('returns a zero summary for a store with no unresolved caller facts', () => {
    const db = new Database(':memory:');
    applyInitialSchema(db);
    const summary = runJsResolve(db, { projectRoot: '/nonexistent' });
    expect(summary).toEqual({ examined: 0, resolved: 0 });
  });
});
