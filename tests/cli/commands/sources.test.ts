import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourcesCommand } from '../../../src/cli/commands/sources.js';
import { makeIo } from '../_helpers/makeIo.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

describe('sourcesCommand', () => {
  const getTmp = useTmpDir('ti-sources-command-');

  it('builds the graph in memory and returns sources', async () => {
    const root = getTmp();
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'ti.config.ts'), `export default {
  tests: { jest: { fileGlobs: ['tests/**/*.test.ts'] } },
  confidence: { threshold: 0 },
};\n`);
    writeFileSync(join(root, 'src/cart.ts'), 'export function cart() {}\n');
    writeFileSync(join(root, 'tests/cart.test.ts'), `
import { cart } from '../src/cart';
test('uses cart', () => { cart(); });
`);

    const t = makeIo();
    const code = await sourcesCommand({
      projectRoot: root,
      io: t.io,
      testIds: ['jest:tests/cart.test.ts::uses cart'],
      format: 'args',
      minConfidence: 0,
      strict: true,
    });

    expect(code).toBe(0);
    expect(t.out).toContain('src/cart.ts');
    expect(existsSync(join(root, '.ti'))).toBe(false);
  });
});
