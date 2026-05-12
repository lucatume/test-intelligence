import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configCommand } from '../../../src/cli/commands/config.js';
import { makeIo } from '../_helpers/makeIo.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

describe('configCommand', () => {
  const getTmp = useTmpDir('ti-config-');

  it('prints defaults JSON when no config file exists', async () => {
    const root = getTmp();
    const t = makeIo();
    const code = await configCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    const parsed = JSON.parse(t.out) as Record<string, unknown>;
    expect((parsed.traversal as { maxDepth: number }).maxDepth).toBe(25);
    expect(t.err).toContain('from-defaults');
  });

  it('honours an existing ti.config.ts override', async () => {
    const root = getTmp();
    writeFileSync(
      join(root, 'ti.config.ts'),
      `export default { traversal: { maxDepth: 10 } };\n`,
    );
    const t = makeIo();
    const code = await configCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(0);
    const parsed = JSON.parse(t.out) as Record<string, unknown>;
    expect((parsed.traversal as { maxDepth: number }).maxDepth).toBe(10);
  });

  it('walks parents to find ti.config.ts (subdir invocation)', async () => {
    const root = getTmp();
    writeFileSync(
      join(root, 'ti.config.ts'),
      `export default { traversal: { maxDepth: 7 } };\n`,
    );
    const subdir = join(root, 'src', 'deep', 'leaf');
    mkdirSync(subdir, { recursive: true });
    const t = makeIo();
    const code = await configCommand({ projectRoot: subdir, io: t.io });
    expect(code).toBe(0);
    const parsed = JSON.parse(t.out) as Record<string, unknown>;
    expect((parsed.traversal as { maxDepth: number }).maxDepth).toBe(7);
  });

  it('exits 1 with a stderr error when the config fails parseConfig', async () => {
    const root = getTmp();
    writeFileSync(
      join(root, 'ti.config.ts'),
      `export default { traversal: { maxDepth: -1 } };\n`,
    );
    const t = makeIo();
    const code = await configCommand({ projectRoot: root, io: t.io });
    expect(code).toBe(1);
    expect(t.err).toContain('maxDepth');
  });
});
