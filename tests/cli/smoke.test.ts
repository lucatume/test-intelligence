import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../helpers/tmpDir.js';

const CLI_ENTRY = join(process.cwd(), 'dist', 'cli.js');

describe('ti CLI smoke (built artifact)', () => {
  const getTmp = useTmpDir('ti-smoke-');

  if (!existsSync(CLI_ENTRY)) {
    it.skip('dist/cli.js not built - run `npm run build` first', () => {
      // Skipped marker: nothing to assert.
    });
    return;
  }

  it('--help prints to stdout and exits 0', () => {
    const r = spawnSync('node', [CLI_ENTRY, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ti - test intelligence');
  });

  it('--version prints to stdout and exits 0', () => {
    const r = spawnSync('node', [CLI_ENTRY, '--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it('init creates ti.config.ts and .ti/', () => {
    const root = getTmp();
    const r = spawnSync('node', [CLI_ENTRY, 'init'], { encoding: 'utf8', cwd: root });
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'ti.config.ts'))).toBe(true);
    expect(existsSync(join(root, '.ti'))).toBe(true);
  });
});
