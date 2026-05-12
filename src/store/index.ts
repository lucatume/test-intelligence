export { openStore } from './open.js';
export type { OpenStore, OpenStoreError } from './open.js';
export { CURRENT_SCHEMA_VERSION } from './migrations.js';
export { acquireLock, releaseLock } from './lock.js';
export type { AcquireOpts, LockError, LockPayload } from './lock.js';
