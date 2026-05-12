import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigFile } from '../../config/load.js';
import { parseConfig } from '../../config/parse.js';
import type { ValidationError } from '../../parse.js';
import type { Io } from '../io.js';

export interface ConfigCommandOpts {
  readonly projectRoot: string;
  readonly io: Io;
}

// Mirrors src/config/resolve.ts CONFIG_CANDIDATES preference order.
const CONFIG_CANDIDATES: readonly string[] = [
  'ti.config.ts',
  'ti.config.mts',
  'ti.config.mjs',
  'ti.config.js',
  'ti.config.cjs',
];

export async function configCommand(opts: ConfigCommandOpts): Promise<number> {
  const { projectRoot, io } = opts;
  const configPath = findConfigFile(projectRoot);

  let raw: unknown = {};
  if (configPath !== null) {
    const loaded = await loadConfigFile(configPath);
    if (loaded.kind === 'err') {
      io.stderr.write(`ti: error: ${loaded.error.message}\n`);
      return 1;
    }
    raw = loaded.value;
  } else {
    io.stderr.write(`ti: notice: from-defaults - no ti.config.{ts,mts,mjs,js,cjs} at ${projectRoot}\n`);
  }

  const parsed = parseConfig(raw);
  if (parsed.kind === 'err') {
    io.stderr.write(`ti: error: ${formatValidationErrors(parsed.error)}\n`);
    return 1;
  }

  io.stdout.write(JSON.stringify(parsed.value, null, 2) + '\n');
  return 0;
}

function findConfigFile(projectRoot: string): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const p = join(projectRoot, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((e) => {
      const where = e.path.length === 0 ? '<root>' : e.path.join('.');
      return `${where}: ${e.message}`;
    })
    .join('; ');
}
