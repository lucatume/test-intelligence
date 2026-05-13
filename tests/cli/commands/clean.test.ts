import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanCommand } from '../../../src/cli/commands/clean.js';
import { useTmpDir } from '../../helpers/tmpDir.js';
import { makeIo } from '../_helpers/makeIo.js';

describe('cleanCommand', () => {
  const getTmp = useTmpDir('ti-clean-cmd-');

  it('removes .ti/ contents', () => {
    const root = getTmp();
    mkdirSync(join(root, '.ti'), { recursive: true });
    writeFileSync(join(root, '.ti/store.db'), 'x');
    const t = makeIo();
    expect(cleanCommand({ projectRoot: root, io: t.io, all: false, force: false })).toBe(0);
    expect(existsSync(join(root, '.ti/store.db'))).toBe(false);
    expect(existsSync(join(root, '.ti'))).toBe(true);
  });

  it('with --all removes the .ti/ directory entirely (not just contents)', () => {
    const root = getTmp();
    mkdirSync(join(root, '.ti'), { recursive: true });
    writeFileSync(join(root, '.ti/store.db'), 'x');
    const t = makeIo();
    expect(cleanCommand({ projectRoot: root, io: t.io, all: true, force: false })).toBe(0);
    expect(existsSync(join(root, '.ti'))).toBe(false);
  });

  it('preserves ti.config.ts even with --all', () => {
    // User config is owned by the user; cleaning ti's working state should
    // never silently delete it. Surprising deletions cost more than the
    // marginal convenience of a single-command full wipe.
    const root = getTmp();
    mkdirSync(join(root, '.ti'), { recursive: true });
    writeFileSync(join(root, 'ti.config.ts'), 'export default {};');
    const t = makeIo();
    expect(cleanCommand({ projectRoot: root, io: t.io, all: true, force: false })).toBe(0);
    expect(existsSync(join(root, 'ti.config.ts'))).toBe(true);
  });
});
