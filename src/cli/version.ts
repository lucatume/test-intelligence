import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

export function versionString(): string {
  // Resolve relative to this compiled file. From dist/cli/version.js the
  // manifest is two dirs up; from the source tree it is also two dirs up.
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, '..', '..', 'package.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as { version?: unknown };
  if (typeof manifest.version !== 'string') {
    throw new Error(`package.json at ${manifestPath} is missing a string "version"`);
  }
  return manifest.version;
}
