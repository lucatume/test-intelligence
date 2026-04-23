import * as path from 'node:path';
import { parseArgv } from './argv.js';
import type { ParsedCommand } from './argv.js';
import type { Io } from './io.js';
import { HELP_TEXT } from './help.js';
import { versionString } from './version.js';
import { resolveProjectRoot } from '../config/resolve.js';
import { unlockManaged } from '../storage/lock.js';
import { exitCodeFor, stderrLine } from '../errors.js';
import type { TiError } from '../errors.js';
import type { Clock } from '../clock.js';

export type DispatchInput = {
  readonly argv: readonly string[];
  readonly io: Io;
  readonly cwd: string;
  readonly clock: Clock;
};

function emitError(io: Io, err: TiError): void {
  io.stderr.write(`${stderrLine(err, 'error')}\n`);
}

function emitNotice(io: Io, message: string): void {
  io.stderr.write(`ti: info: ${message}\n`);
}

function runHelp(io: Io): 0 {
  io.stdout.write(HELP_TEXT);
  return 0;
}

function runVersion(io: Io): 0 {
  io.stdout.write(`${versionString()}\n`);
  return 0;
}

async function runUnlock(
  cmd: Extract<ParsedCommand, { kind: 'unlock' }>,
  io: Io,
  cwd: string,
): Promise<number> {
  const rooted = await resolveProjectRoot(cwd);
  if (rooted.kind === 'err') {
    emitError(io, rooted.error);
    return exitCodeFor(rooted.error, { strict: false });
  }
  const tiDir = path.join(rooted.value.projectRoot, '.test-intelligence');
  const r = await unlockManaged({ tiDir, force: cmd.force });
  if (r.kind === 'err') {
    emitError(io, r.error);
    return exitCodeFor(r.error, { strict: false });
  }
  if (r.value.kind === 'no-lock') {
    emitNotice(io, `no lock at ${path.join(tiDir, '.lock')}`);
    return 0;
  }
  const prev = r.value.previous;
  if (prev === null) {
    emitNotice(io, 'released unparseable lock file');
  } else {
    emitNotice(io, `released lock (was pid=${String(prev.pid)}, host=${prev.hostname}, command='${prev.command}')`);
  }
  return 0;
}

export async function dispatch(input: DispatchInput): Promise<number> {
  const parsed = parseArgv({ argv: input.argv, stdinIsTty: input.io.stdinIsTty });
  if (parsed.kind === 'err') {
    emitError(input.io, parsed.error);
    return exitCodeFor(parsed.error, { strict: false });
  }
  const cmd = parsed.value;
  switch (cmd.kind) {
    case 'help':    return runHelp(input.io);
    case 'version': return runVersion(input.io);
    case 'unlock':  return runUnlock(cmd, input.io, input.cwd);
    case 'tests':
    case 'sources':
    case 'explain':
      // Wired in Task 19.
      emitError(input.io, { kind: 'CliError', message: `command '${cmd.kind}' not yet wired in dispatch` });
      return 1;
  }
}
