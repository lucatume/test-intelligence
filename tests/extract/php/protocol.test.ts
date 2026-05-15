import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Protocol } from '../../../src/extract/php/protocol.js';

// Minimal child stub: an EventEmitter with stdin/stdout streams.
function makeChild(stdinDestroyed: boolean): {
  child: ChildProcessWithoutNullStreams;
  emitExit: () => void;
} {
  const ee = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  if (stdinDestroyed) stdin.destroy();
  Object.assign(ee, { stdin, stdout });
  return { child: ee, emitExit: () => { ee.emit('exit'); } };
}

describe('Protocol.shutdown', () => {
  it('does not throw when the worker stdin is already destroyed', async () => {
    const { child } = makeChild(true);
    const proto = new Protocol(child);
    await expect(proto.shutdown()).resolves.toBeUndefined();
  });

  it('does not crash on an async stdin error event', async () => {
    const { child, emitExit } = makeChild(false);
    const proto = new Protocol(child);
    // Simulate an asynchronous EPIPE surfacing on the stdin socket.
    child.stdin.emit('error', new Error('write EPIPE'));
    const done = proto.shutdown();
    emitExit();
    await expect(done).resolves.toBeUndefined();
  });
});
