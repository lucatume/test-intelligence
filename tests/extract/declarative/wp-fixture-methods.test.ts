import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractFile } from '../../../src/extract/index.js';
import { synthesizeCompilerOptions } from '../../../src/extract/ts/compiler.js';
import { useTmpDir } from '../../helpers/tmpDir.js';
import { unsafeCoerce } from '../../helpers/unsafeCoerce.js';
import type { ProjectRelativePath } from '../../../src/types.js';

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

async function extract(root: string, rel: string): ReturnType<typeof extractFile> {
  const opts = synthesizeCompilerOptions(root);
  return extractFile({
    projectRoot: root,
    path: unsafeCoerce<ProjectRelativePath>(rel),
    language: 'ts',
    framework: null,
    compilerOptions: opts,
    patterns: [],
  });
}

describe('@wordpress/e2e-test-utils-playwright fixture method patterns', () => {
  const getTmp = useTmpDir('ti-wp-fixture-');

  it('admin.visitAdminPage("admin.php?page=foo") emits admin-page-nav for slug "foo"', async () => {
    const root = getTmp();
    write(root, 'a.test.ts', `
import { test } from '@wordpress/e2e-test-utils-playwright';
test('x', async ({ admin }) => { await admin.visitAdminPage('admin.php?page=foo'); });
`);
    const r = await extract(root, 'a.test.ts');
    if (r.kind !== 'ok') throw new Error('extract failed');
    const navs = r.value.filter((f) => f.kind === 'admin-page-nav');
    expect(navs).toHaveLength(1);
    expect(navs[0]?.anchors[0]?.key).toBe('wp-admin-page:foo');
  });

  it('admin.visitAdminPage("edit.php") emits admin-page-nav for slug "edit.php"', async () => {
    const root = getTmp();
    write(root, 'a.test.ts', `
import { test } from '@wordpress/e2e-test-utils-playwright';
test('x', async ({ admin }) => { await admin.visitAdminPage('edit.php'); });
`);
    const r = await extract(root, 'a.test.ts');
    if (r.kind !== 'ok') throw new Error('extract failed');
    const navs = r.value.filter((f) => f.kind === 'admin-page-nav');
    expect(navs).toHaveLength(1);
    expect(navs[0]?.anchors[0]?.key).toBe('wp-admin-page:edit.php');
  });

  it('admin.createNewPost emits admin-page-nav for post-new.php', async () => {
    const root = getTmp();
    write(root, 'a.test.ts', `
import { test } from '@wordpress/e2e-test-utils-playwright';
test('x', async ({ admin }) => { await admin.createNewPost({ title: 'Hi' }); });
`);
    const r = await extract(root, 'a.test.ts');
    if (r.kind !== 'ok') throw new Error('extract failed');
    const navs = r.value.filter((f) => f.kind === 'admin-page-nav');
    expect(navs.map((f) => f.anchors[0]?.key)).toContain('wp-admin-page:post-new.php');
  });

  it('requestUtils.deleteAllPosts emits rest-call-js for DELETE /wp/v2/posts/{*}', async () => {
    const root = getTmp();
    write(root, 'a.test.ts', `
import { test } from '@wordpress/e2e-test-utils-playwright';
test('x', async ({ requestUtils }) => { await requestUtils.deleteAllPosts(); });
`);
    const r = await extract(root, 'a.test.ts');
    if (r.kind !== 'ok') throw new Error('extract failed');
    const rest = r.value.filter((f) => f.kind === 'rest-call-js');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:DELETE /wp/v2/posts/{*}');
  });

  it('editor.publishPost emits admin-page-nav for post.php', async () => {
    const root = getTmp();
    write(root, 'a.test.ts', `
import { test } from '@wordpress/e2e-test-utils-playwright';
test('x', async ({ editor }) => { await editor.publishPost(); });
`);
    const r = await extract(root, 'a.test.ts');
    if (r.kind !== 'ok') throw new Error('extract failed');
    const navs = r.value.filter((f) => f.kind === 'admin-page-nav');
    expect(navs.map((f) => f.anchors[0]?.key)).toContain('wp-admin-page:post.php');
  });
});
