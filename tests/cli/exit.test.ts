import { describe, it, expect } from 'vitest';
import { exitAfterFlush, type FlushableStream } from '../../src/cli/exit.js';

// Stub stream that queues write callbacks and releases them only when the
// test calls drain() — models a pipe with a slow consumer.
function makeStubStream(): FlushableStream & { drain(): void; pending: number } {
  const cbs: Array<() => void> = [];
  return {
    write(_chunk: string, cb?: (err?: Error | null) => void): boolean {
      if (cb) cbs.push(() => { cb(null); });
      return false;
    },
    drain(): void {
      while (cbs.length > 0) {
        const cb = cbs.shift();
        if (cb) cb();
      }
    },
    get pending(): number {
      return cbs.length;
    },
  };
}

describe('exitAfterFlush', () => {
  it('does not exit before every stream has flushed', () => {
    const out = makeStubStream();
    const errStream = makeStubStream();
    const calls: number[] = [];
    exitAfterFlush([out, errStream], 3, (code) => calls.push(code));

    expect(calls).toEqual([]);      // nothing flushed yet
    out.drain();
    expect(calls).toEqual([]);      // stderr still pending
    errStream.drain();
    expect(calls).toEqual([3]);     // both flushed → exit once, with the code
  });

  it('exits exactly once even if a stream fires its callback twice', () => {
    const out = makeStubStream();
    const calls: number[] = [];
    exitAfterFlush([out], 0, (code) => calls.push(code));
    out.drain();
    out.drain();
    expect(calls).toEqual([0]);
  });

  it('exits immediately when given no streams', () => {
    const calls: number[] = [];
    exitAfterFlush([], 1, (code) => calls.push(code));
    expect(calls).toEqual([1]);
  });
});
