import type { Io } from './cli/io.js';

export function run(argv: readonly string[], io: Io): Promise<number> {
  io.stderr.write('ti: not implemented yet\n');
  void argv;
  return Promise.resolve(1);
}
