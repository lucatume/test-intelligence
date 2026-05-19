import type Database from 'better-sqlite3';
import type { JsResolveOptions, JsResolveSummary } from './types.js';

// Post-extraction, pre-derive cross-file pass: resolve unresolved
// ajax-call-js / rest-call-js caller arguments interprocedurally and flip
// the facts to resolved. Stub — filled in Task 8.
export function runJsResolve(_db: Database.Database, _opts: JsResolveOptions): JsResolveSummary {
  return { examined: 0, resolved: 0 };
}
