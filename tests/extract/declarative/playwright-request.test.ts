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

describe('Playwright APIRequestContext patterns', () => {
  const getTmp = useTmpDir('ti-pw-request-');

  it('request.get("./wp-json/ti/v1/items") emits rest-call-js with normalised anchor', async () => {
    const root = getTmp();
    const rel = 'tests/api.test.ts';
    write(root, rel, `
import { test } from '@playwright/test';
test('x', async ({ request }) => {
  await request.get('./wp-json/ti/v1/items');
  await request.post('/wp-json/ti/v1/items', { data: {} });
  await request.delete(\`/wp-json/ti/v1/items/\${id}\`);
});
`);
    const opts = synthesizeCompilerOptions(root);
    const r = await extractFile({
      projectRoot: root,
      path: unsafeCoerce<ProjectRelativePath>(rel),
      language: 'ts',
      framework: null,
      compilerOptions: opts,
      patterns: [],
    });
    if (r.kind !== 'ok') throw new Error('extract failed');
    const rest = r.value.filter((f) => f.kind === 'rest-call-js');
    expect(rest).toHaveLength(3);
    const anchors = rest.flatMap((f) => f.anchors.map((a) => a.key));
    expect(anchors).toContain('rest:GET /ti/v1/items');
    expect(anchors).toContain('rest:POST /ti/v1/items');
    expect(anchors).toContain('rest:DELETE /ti/v1/items/{*}');
  });

  it('requestUtils.<method> emits the same shape', async () => {
    const root = getTmp();
    const rel = 'tests/api.test.ts';
    write(root, rel, `
import { test } from '@wordpress/e2e-test-utils-playwright';
test('x', async ({ requestUtils }) => {
  await requestUtils.get('/wp-json/ti/v1/things');
});
`);
    const opts = synthesizeCompilerOptions(root);
    const r = await extractFile({
      projectRoot: root,
      path: unsafeCoerce<ProjectRelativePath>(rel),
      language: 'ts',
      framework: null,
      compilerOptions: opts,
      patterns: [],
    });
    if (r.kind !== 'ok') throw new Error('extract failed');
    const rest = r.value.filter((f) => f.kind === 'rest-call-js');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.anchors[0]?.key).toBe('rest:GET /ti/v1/things');
  });
});
