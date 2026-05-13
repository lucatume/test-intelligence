import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { matchesAny } from './glob.js';
import { classifyFile } from './framework.js';
import type { DiscoveredFile } from './types.js';
import type { ValidatedConfig } from '../config/parse.js';
import { parseProjectRelativePath } from '../paths.js';

export async function* walk(
  projectRoot: string,
  config: ValidatedConfig,
): AsyncIterable<DiscoveredFile> {
  yield* walkInner(projectRoot, projectRoot, config);
}

async function* walkInner(
  projectRoot: string,
  dirAbs: string,
  config: ValidatedConfig,
): AsyncIterable<DiscoveredFile> {
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dirAbs, e.name);
    const relPosix = toPosix(relative(projectRoot, full));
    if (matchesAny(relPosix, config.ignore)) continue;

    let isDir: boolean;
    let isFile: boolean;
    if (e.isSymbolicLink()) {
      const parsed = parseProjectRelativePath(relPosix, projectRoot, {
        allowSymlinkTargets: config.allowSymlinkTargets,
      });
      if (parsed.kind === 'err') continue;
      try {
        const st = await fs.stat(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    } else {
      isDir = e.isDirectory();
      isFile = e.isFile();
    }

    if (isDir) {
      yield* walkInner(projectRoot, full, config);
      continue;
    }
    if (!isFile) continue;

    const cls = classifyFile(relPosix, config);
    if (cls === null) continue;

    const branded = parseProjectRelativePath(relPosix, projectRoot, {
      allowSymlinkTargets: config.allowSymlinkTargets,
    });
    if (branded.kind === 'err') continue;

    const vendor = matchesAny(relPosix, config.vendor);
    // Vendor packages ship their own tests; treating them as project tests
    // pollutes results. Keep them indexed as sources (their symbol-defs
    // can still be referenced) but never as tests.
    const framework = vendor ? null : cls.framework;
    const frameworkClass = vendor ? null : cls.frameworkClass;
    yield {
      path: branded.value,
      language: cls.language,
      vendor,
      framework,
      frameworkClass,
    };
  }
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
