import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../../../src/cli/commands/init.js';
import { makeIo } from '../_helpers/makeIo.js';

describe('initCommand', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ti-init-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates ti.config.ts in an empty directory and ensures .ti/ exists', async () => {
    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    expect(existsSync(join(root, 'ti.config.ts'))).toBe(true);
    expect(existsSync(join(root, '.ti'))).toBe(true);
    const content = readFileSync(join(root, 'ti.config.ts'), 'utf8');
    expect(content).toContain('defineConfig');
  });

  it('is a no-op when ti.config.ts already exists', async () => {
    writeFileSync(join(root, 'ti.config.ts'), '// existing user file\n');
    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    expect(readFileSync(join(root, 'ti.config.ts'), 'utf8')).toBe('// existing user file\n');
    expect(t.err).toContain('already exists');
  });

  it('detects PHPUnit when composer.json names it as a dev dep', async () => {
    writeFileSync(
      join(root, 'composer.json'),
      JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^11.0' } }),
    );
    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    const content = readFileSync(join(root, 'ti.config.ts'), 'utf8');
    expect(content).toContain('phpunit');
  });

  it('detects Jest from package.json devDependencies', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    );
    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    const content = readFileSync(join(root, 'ti.config.ts'), 'utf8');
    expect(content).toContain('jest');
  });
});
