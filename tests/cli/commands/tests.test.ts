import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testsCommand } from '../../../src/cli/commands/tests.js';
import { makeIo } from '../_helpers/makeIo.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

describe('testsCommand', () => {
  const getTmp = useTmpDir('ti-tests-command-');

  it('builds the graph in memory, returns tests, and leaves no .ti directory', async () => {
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
    const code = await testsCommand({
      projectRoot: root,
      io: t.io,
      sources: ['src/cart.ts'],
      framework: 'jest',
      format: 'args',
      minConfidence: 0,
      strict: true,
    });

    expect(code).toBe(0);
    expect(t.out).toContain('jest:tests/cart.test.ts::uses cart');
    expect(existsSync(join(root, '.ti'))).toBe(false);
  });
});
