import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { Io } from './cli/io.js';
import { HELP_TEXT } from './cli/help.js';
import { parseArgv } from './cli/parseArgv.js';
import { versionString } from './cli/version.js';
import { initCommand } from './cli/commands/init.js';

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const cmd = parseArgv(argv);
  switch (cmd.kind) {
    case 'help':
      io.stdout.write(HELP_TEXT);
      return 0;
    case 'version':
      io.stdout.write(versionString() + '\n');
      return 0;
    case 'init':
      return initCommand({ projectRoot: process.cwd(), io });
    case 'config':
      return (await import('./cli/commands/config.js')).configCommand({
        projectRoot: process.cwd(),
        io,
      });
    case 'build':
      return (await import('./cli/commands/build.js')).buildCommand({
        projectRoot: process.cwd(),
        io,
        verbosity: cmd.verbosity,
      });
    case 'update':
      return (await import('./cli/commands/update.js')).updateCommand({
        projectRoot: process.cwd(),
        io,
        verbosity: cmd.verbosity,
        paths: cmd.paths,
      });
    case 'not-implemented':
      io.stderr.write(`ti: ${cmd.verb} is not yet implemented in this build\n`);
      return 1;
    case 'unknown-command':
      io.stderr.write(`ti: unknown command "${cmd.input}" - see \`ti --help\`\n`);
      return 1;
  }
}

// Bootstrap when invoked as a binary (not when imported as a library).
// `process.argv[1]` is the script path; resolve symlinks on both sides so a
// symlinked bin (e.g. node_modules/.bin/ti -> dist/cli.js) still matches.
const isMain = (() => {
  try {
    const moduleUrl = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (argv1 === undefined) return false;
    return realpathSync(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
})();

if (isMain) {
  const realIo: Io = {
    stdout: process.stdout,
    stderr: process.stderr,
    readStdin: () =>
      new Promise<string>((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => {
          data += chunk;
        });
        process.stdin.on('end', () => {
          resolve(data);
        });
        process.stdin.on('error', (err) => {
          reject(err);
        });
      }),
    stdinIsTty: process.stdin.isTTY ? true : false,
  };
  run(process.argv.slice(2), realIo)
    .then((code) => {
      process.exit(code);
    })
    .catch((e: unknown) => {
      process.stderr.write(`ti: error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
