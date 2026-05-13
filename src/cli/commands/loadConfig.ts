import type { Io } from '../io.js';
import { loadConfigFile } from '../../config/load.js';
import { resolveProjectRoot } from '../../config/resolve.js';
import { parseConfig, type ValidatedConfig } from '../../config/parse.js';

export async function loadEffectiveConfig(projectRoot: string, io: Io): Promise<ValidatedConfig | null> {
  const resolved = await resolveProjectRoot(projectRoot);
  if (resolved.kind === 'err') {
    const r = parseConfig({});
    if (r.kind === 'err') {
      io.stderr.write('ti: failed to parse defaults\n');
      return null;
    }
    return r.value;
  }
  const loaded = await loadConfigFile(resolved.value.configFile);
  if (loaded.kind === 'err') {
    io.stderr.write(`ti: ${loaded.error.message}\n`);
    return null;
  }
  const parsed = parseConfig(loaded.value);
  if (parsed.kind === 'err') {
    io.stderr.write('ti: config validation failed:\n');
    for (const e of parsed.error) io.stderr.write(`  ${e.path.join('.')}: ${e.message}\n`);
    return null;
  }
  return parsed.value;
}
