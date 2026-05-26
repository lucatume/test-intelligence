import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractFile } from '../../../src/extract/index.js';
import { synthesizeCompilerOptions } from '../../../src/extract/ts/compiler.js';
import type { ProjectRelativePath } from '../../../src/types.js';
import { unsafeCoerce } from '../../helpers/unsafeCoerce.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

describe('page.goto front-end / bare wp-admin URLs', () => {
  const getTmp = useTmpDir('ti-pw-frontend-');

  it('page.goto("/wp-admin/edit.php") emits admin-page-nav with anchor wp-admin-page:edit.php', async () => {
    const root = getTmp();
    write(root, 'a.test.ts', `
import { test } from '@playwright/test';
test('x', async ({ page }) => { await page.goto('/wp-admin/edit.php'); });
`);
    const opts = synthesizeCompilerOptions(root);
    const r = await extractFile({
      projectRoot: root,
      path: unsafeCoerce<ProjectRelativePath>('a.test.ts'),
      language: 'ts',
      framework: 'playwright',
      compilerOptions: opts,
      patterns: [],
    });
    if (r.kind !== 'ok') throw new Error('extract failed');
    const navs = r.value.filter((f) => f.kind === 'admin-page-nav');
    expect(navs).toHaveLength(1);
    expect(navs[0]?.anchors[0]?.key).toBe('wp-admin-page:edit.php');
  });

  it('page.goto("/wp-admin/admin.php?page=foo") still resolves via slug transform', async () => {
    const root = getTmp();
    write(root, 'a.test.ts', `
import { test } from '@playwright/test';
test('x', async ({ page }) => { await page.goto('/wp-admin/admin.php?page=foo'); });
`);
    const opts = synthesizeCompilerOptions(root);
    const r = await extractFile({
      projectRoot: root,
      path: unsafeCoerce<ProjectRelativePath>('a.test.ts'),
      language: 'ts',
      framework: 'playwright',
      compilerOptions: opts,
      patterns: [],
    });
    if (r.kind !== 'ok') throw new Error('extract failed');
    const navs = r.value.filter((f) => f.kind === 'admin-page-nav');
    expect(navs).toHaveLength(1);
    expect(navs[0]?.anchors[0]?.key).toBe('wp-admin-page:foo');
  });

  it('page.goto("/hello-world/") emits no fact', async () => {
    const root = getTmp();
    write(root, 'a.test.ts', `
import { test } from '@playwright/test';
test('x', async ({ page }) => { await page.goto('/hello-world/'); });
`);
    const opts = synthesizeCompilerOptions(root);
    const r = await extractFile({
      projectRoot: root,
      path: unsafeCoerce<ProjectRelativePath>('a.test.ts'),
      language: 'ts',
      framework: 'playwright',
      compilerOptions: opts,
      patterns: [],
    });
    if (r.kind !== 'ok') throw new Error('extract failed');
    const navs = r.value.filter((f) => f.kind === 'admin-page-nav');
    expect(navs).toHaveLength(0);
  });
});
