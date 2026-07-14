import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initCommand } from '../../../src/cli/commands/init.js';
import { makeIo } from '../_helpers/makeIo.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

describe('initCommand', () => {
  const getTmp = useTmpDir('ti-init-');

  it('creates only ti.config.ts in an empty directory', async () => {
    const root = getTmp();
    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    expect(existsSync(join(root, 'ti.config.ts'))).toBe(true);
    expect(existsSync(join(root, '.ti'))).toBe(false);
    const content = readFileSync(join(root, 'ti.config.ts'), 'utf8');
    expect(content).toContain('export default');
    // Generated config must not import 'ti' so it loads in projects that
    // don't have the package installed as a dependency.
    expect(content).not.toMatch(/from ['"]ti['"]/);
  });

  it('is a no-op when ti.config.ts already exists', async () => {
    const root = getTmp();
    writeFileSync(join(root, 'ti.config.ts'), '// existing user file\n');
    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    expect(readFileSync(join(root, 'ti.config.ts'), 'utf8')).toBe('// existing user file\n');
    expect(t.err).toContain('already exists');
  });

  it('detects PHPUnit when composer.json names it as a dev dep', async () => {
    const root = getTmp();
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
    const root = getTmp();
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

  it('derives playwright fileGlobs from located playwright.config files', async () => {
    // The classifier needs explicit globs to mark a .spec.ts as playwright,
    // otherwise the default jest glob swallows it. Use the location of each
    // playwright.config.* as a strong signal for where pw tests live.
    const root = getTmp();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'plugins', 'a', 'tests', 'e2e-pw'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { '@playwright/test': '^1.0.0' } }),
    );
    writeFileSync(
      join(root, 'plugins', 'a', 'tests', 'e2e-pw', 'playwright.config.ts'),
      "import { defineConfig } from '@playwright/test'; export default defineConfig({});",
    );
    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    const content = readFileSync(join(root, 'ti.config.ts'), 'utf8');
    expect(content).toContain('plugins/a/tests/e2e-pw/**/*.spec.{ts,tsx,js,jsx}');
  });

  it('falls back to conventional playwright globs when no config is found', async () => {
    const root = getTmp();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { '@playwright/test': '^1.0.0' } }),
    );
    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    const content = readFileSync(join(root, 'ti.config.ts'), 'utf8');
    // Conservative defaults that do not steal generic .spec files from jest.
    expect(content).toMatch(/\*\*\/e2e[-_]?pw\/\*\*\/\*\.spec/);
  });

  it('detects frameworks declared in nested manifests (monorepo layout)', async () => {
    const root = getTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'plugins', 'woocommerce'), { recursive: true });
    mkdirSync(join(root, 'packages', 'js', 'admin'), { recursive: true });
    writeFileSync(
      join(root, 'plugins', 'woocommerce', 'composer.json'),
      JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^11.0' } }),
    );
    writeFileSync(
      join(root, 'packages', 'js', 'admin', 'package.json'),
      JSON.stringify({ devDependencies: { '@playwright/test': '^1.0.0' } }),
    );
    // Declarations buried inside node_modules must not count.
    mkdirSync(join(root, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'some-pkg', 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    );

    const t = makeIo();
    const code = await initCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    const content = readFileSync(join(root, 'ti.config.ts'), 'utf8');
    expect(content).toContain('phpunit');
    expect(content).toContain('playwright');
    expect(content).not.toContain('jest:');
  });

});
