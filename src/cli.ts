#!/usr/bin/env node
import { dispatch } from './cli/dispatch.js';
import type { Io } from './cli/io.js';
import { systemClock } from './clock.js';

async function readStdinAll(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const io: Io = {
    stdout: { write: (c) => { process.stdout.write(c); } },
    stderr: { write: (c) => { process.stderr.write(c); } },
    readStdin: readStdinAll,
    stdinIsTty: (process.stdin as NodeJS.ReadStream & { isTTY: boolean | undefined }).isTTY ? true : false,
  };
  const code = await dispatch({
    argv: process.argv.slice(2),
    io,
    cwd: process.cwd(),
    clock: systemClock,
  });
  process.exit(code);
}

void main().catch((e: unknown) => {
  // Programmer-error path: any exception reaching here is a bug, not an
  // expected failure. Expected failures flow through Result<T, TiError> and
  // never throw. Surface with a non-zero exit and a stack trace on stderr.
  process.stderr.write(`ti: fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
