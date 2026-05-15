export { openStore } from './open.js';
export type { OpenStore, OpenStoreError } from './open.js';
export { CURRENT_SCHEMA_VERSION } from './migrations.js';
export { acquireLock, releaseLock } from './lock.js';
export type { AcquireOpts, LockError, LockPayload } from './lock.js';
export {
  upsertFile,
  insertFact,
  upsertAnchor,
  insertFactAnchor,
  insertTest,
  insertEdge,
  insertEdgesBulk,
  clearEdgesForTest,
  clearAllEdges,
  clearFactsForFile,
} from './writers.js';
export type {
  FileInsert,
  FactInsert,
  AnchorInsert,
  FactAnchorInsert,
  TestInsert,
  EdgeInsert,
} from './writers.js';
export { removeStoreContents } from './clean.js';
export type { CleanOptions, CleanError } from './clean.js';
