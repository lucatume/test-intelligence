import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

describe('ti binary entrypoint', () => {
  it('--help exits 0 and prints USAGE', () => {
    const r = spawnSync(
      process.execPath,
      ['--import', 'jiti/register', path.join(REPO_ROOT, 'src', 'cli.ts'), '--help'],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/USAGE/);
  });

  it('unknown command exits 1 and writes to stderr', () => {
    const r = spawnSync(
      process.execPath,
      ['--import', 'jiti/register', path.join(REPO_ROOT, 'src', 'cli.ts'), 'wat'],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ti: error:/);
  });
});
