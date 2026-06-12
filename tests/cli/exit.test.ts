import { describe, it, expect } from 'vitest';
import { exitAfterFlush, type FlushableStream } from '../../src/cli/exit.js';

// Pins that process.stdout satisfies FlushableStream without a cast — required
// for the CLI wiring in src/cli.ts to remain cast-free.
void (process.stdout satisfies FlushableStream);

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
      // Iterate without consuming so a second drain() re-fires all callbacks —
      // models a misbehaving stream that invokes the write callback more than once.
      for (const cb of cbs) cb();
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

  it('a double-firing stream does not cause exit before other streams flush', () => {
    const a = makeStubStream();
    const b = makeStubStream();
    const calls: number[] = [];
    exitAfterFlush([a, b], 7, (code) => calls.push(code));
    a.drain();
    a.drain();          // double-fire on a
    expect(calls).toEqual([]);   // b still pending — must NOT have exited
    b.drain();
    expect(calls).toEqual([7]);
  });

  it('ignores flush errors and still exits exactly once with the right code', () => {
    const errStream: FlushableStream = {
      write(_chunk: string, cb?: (err?: Error | null) => void): boolean {
        if (cb) cb(new Error('EPIPE'));
        return false;
      },
    };
    const calls: number[] = [];
    exitAfterFlush([errStream], 2, (code) => calls.push(code));
    expect(calls).toEqual([2]);
  });
});
