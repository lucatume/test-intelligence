import type { Io } from '../../../src/cli/io.js';

export interface TestIo {
  readonly io: Io;
  readonly out: string;
  readonly err: string;
}

export function makeIo(): TestIo {
  let out = '';
  let errStr = '';
  const io: Io = {
    stdout: {
      write(s: string): void {
        out += s;
      },
    },
    stderr: {
      write(s: string): void {
        errStr += s;
      },
    },
    readStdin: () => Promise.resolve(''),
    stdinIsTty: true,
  };
  return {
    io,
    get out() {
      return out;
    },
    get err() {
      return errStr;
    },
  };
}
