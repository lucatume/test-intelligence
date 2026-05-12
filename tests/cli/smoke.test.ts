import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../helpers/tmpDir.js';

const CLI_ENTRY = join(process.cwd(), 'dist', 'cli.js');

// Minimal env for the child process: only what `node` needs to start.
// Pinned so future ambient `NODE_OPTIONS` / `TI_*` vars cannot leak in.
const SPAWN_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
};

describe('ti CLI smoke (built artifact)', () => {
  const getTmp = useTmpDir('ti-smoke-');

  if (!existsSync(CLI_ENTRY)) {
    it('dist/cli.js missing - run `npm run build` first', () => {
      throw new Error(`dist/cli.js not found at ${CLI_ENTRY}`);
    });
    return;
  }

  it('--help prints to stdout and exits 0', () => {
    const r = spawnSync('node', [CLI_ENTRY, '--help'], { encoding: 'utf8', env: SPAWN_ENV });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ti - test intelligence');
  });

  it('--version prints to stdout and exits 0', () => {
    const r = spawnSync('node', [CLI_ENTRY, '--version'], { encoding: 'utf8', env: SPAWN_ENV });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('init creates ti.config.ts and .ti/', () => {
    const root = getTmp();
    const r = spawnSync('node', [CLI_ENTRY, 'init'], {
      encoding: 'utf8',
      cwd: root,
      env: SPAWN_ENV,
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'ti.config.ts'))).toBe(true);
    expect(existsSync(join(root, '.ti'))).toBe(true);
  });
});
