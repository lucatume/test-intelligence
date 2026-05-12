import { loadConfigFile } from '../../config/load.js';
import { parseConfig } from '../../config/parse.js';
import { resolveProjectRoot } from '../../config/resolve.js';
import type { ValidationError } from '../../parse.js';
import type { Io } from '../io.js';

export interface ConfigCommandOpts {
  readonly projectRoot: string;
  readonly io: Io;
}

export async function configCommand(opts: ConfigCommandOpts): Promise<number> {
  const { projectRoot, io } = opts;
  const resolved = await resolveProjectRoot(projectRoot);

  let raw: unknown = {};
  if (resolved.kind === 'ok') {
    const loaded = await loadConfigFile(resolved.value.configFile);
    if (loaded.kind === 'err') {
      io.stderr.write(`ti: error: ${loaded.error.message}\n`);
      return 1;
    }
    raw = loaded.value;
  } else {
    io.stderr.write(
      `ti: notice: from-defaults - no ti.config.{ts,mts,mjs,js,cjs} found above ${projectRoot}\n`,
    );
  }

  const parsed = parseConfig(raw);
  if (parsed.kind === 'err') {
    io.stderr.write(`ti: error: ${formatValidationErrors(parsed.error)}\n`);
    return 1;
  }

  io.stdout.write(JSON.stringify(parsed.value, null, 2) + '\n');
  return 0;
}

function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((e) => {
      const where = e.path.length === 0 ? '<root>' : e.path.join('.');
      return `${where}: ${e.message}`;
    })
    .join('; ');
}
