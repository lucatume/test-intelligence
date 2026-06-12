// Minimal structural type so tests can stub it; process.stdout satisfies it.
export interface FlushableStream {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
}

/**
 * Invoke `exit(code)` only after every stream has flushed its queued writes.
 *
 * `process.exit()` does not wait for async stream writes; when stdout is a
 * pipe, anything beyond the OS pipe buffer (~64 KB) is silently dropped.
 * A zero-length write's callback fires only after all previously queued
 * chunks have been handed to the OS — exactly the barrier we need. Forced
 * exit is kept (vs. `process.exitCode` + natural exit) so a lingering
 * handle can never turn truncation into a hang.
 */
export function exitAfterFlush(
  streams: readonly FlushableStream[],
  code: number,
  exit: (code: number) => void,
): void {
  let pending = streams.length;
  let done = false;
  const settle = (): void => {
    pending -= 1;
    if (pending <= 0 && !done) {
      done = true;
      exit(code);
    }
  };
  if (streams.length === 0) {
    exit(code);
    return;
  }
  for (const s of streams) {
    s.write('', () => { settle(); });
  }
}
