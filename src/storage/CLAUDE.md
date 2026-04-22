# src/storage/ — on-disk map

This is the durability layer. Correctness under concurrent access and crashes is the defining concern — preserve the invariants below even when they look like ceremony.

## On-disk layout

Under the project root:

```
.test-intelligence/
  schema-version          # integer; forward-only
  index.json              # by_test / by_view / by_path
  shards/<sha1>.json      # immutable after write
  .lock                   # ephemeral — write-side mutex
  .tmp/                   # ephemeral — staging for durable writes
```

`.lock` and `.tmp/` are **ephemeral siblings** (never committed). `gitignore.ts#ensureGitignore` keeps them out of the user's VCS automatically.

Shards are **immutable after write** — updating the map means writing a new shard + atomically rewriting `index.json`. The read side exploits this: it takes no lock.

## Durable writes (`write.ts`)

Every shard and index write follows the same sequence, in order:

1. Write bytes to a uniquely-named file in `.tmp/`.
2. `fsync` the temp file.
3. `rename()` it over the final path (atomic on POSIX within the same filesystem).
4. `fsync` the containing directory so the rename is itself durable across crash.

Do not shortcut this — a crashed half-write of `index.json` is the most damaging failure mode in the system. Failures of any step return `StorageWriteError`.

## Lock protocol (`lock.ts`)

**Write side only.** Reads do not lock because shards are immutable-after-write and `index.json` is updated atomically.

- Acquire with `O_EXCL` creat — never `exists()`-then-create (TOCTOU).
- Payload is structured JSON: `{ pid, hostname, command, startedAt }`.
- **Stale-check policy** on an existing lock:
  - Hostname mismatch → `LockHostMismatchError` (never steal a cross-host lock; NFS, shared volumes).
  - Same host + PID alive → `LockHeldError` (holder is real).
  - Same host + PID dead → reclaim (overwrite + proceed).
- `registerLockCleanupOnExit(ctx)` wires `SIGINT` / `SIGTERM` / normal-exit handlers so a crashing write-side process does not strand the lock.

When you add a new write-side operation, take the lock for the **whole** critical section — including index rewrite — not just the shard write.

## Gitignore management (`gitignore.ts`)

`ensureGitignore(projectRoot)` maintains a sentinel-delimited managed block at the top of the user's `.gitignore`:

```
# Managed by ti — do not edit these entries.
.lock
.tmp/
# --- ti-managed above; user entries below ---
<user entries preserved verbatim>
```

Every rewrite rebuilds only the section above the sentinel. User entries below the sentinel are never touched. If the sentinel is missing (fresh file), it's inserted.

## Read side (`read.ts`)

`readShard` / `readIndex` return `Result<T, TiError>`:

- `ShardCorruptError { shardPath }` — parse failed or file unreadable.
- `MapNotFoundError` — the map doesn't exist yet (pre-first-scan).

Neither path takes a lock. Neither throws.

## Schema versioning

`schema-version` is **forward-only**. An on-disk version newer than this binary supports is a `SchemaOutOfRangeError` — refuse to operate; do not guess. Downgrades are not in-place: they require `ti clean` + rebuild (see spec §Rollback posture).

When bumping the on-disk schema, bump the supported-range constants together; do not add silent migrations.

## Modify me when…

- A new durability, locking, or on-disk-layout invariant emerges.
- The shard/index schema changes **shape** (not just fields).
- A new ephemeral sibling appears in `.test-intelligence/` (must be added to `ensureGitignore`'s managed entries).
- The lock payload gains or loses a field.

Do **not** modify me for: routine bug fixes, adding fields to an existing shard record, or anything already covered by the spec.
