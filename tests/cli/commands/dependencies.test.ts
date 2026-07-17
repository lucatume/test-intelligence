import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dependenciesCommand } from '../../../src/cli/commands/dependencies.js';
import { makeIo } from '../_helpers/makeIo.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

describe('dependenciesCommand', () => {
  const getTmp = useTmpDir('ti-dependencies-command-');

  function project(): string {
    const root = getTmp();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), "import { b } from './b';\nb();\n");
    writeFileSync(join(root, 'src/b.ts'), 'export function b() {}\n');
    return root;
  }

  it('emits deduplicated args without persistent state', async () => {
    const root = project();
    const t = makeIo();
    const code = await dependenciesCommand({
      projectRoot: root,
      io: t.io,
      sources: ['src/a.ts', 'src/a.ts'],
      format: 'args',
      minConfidence: 0,
      strict: true,
    });

    expect(code).toBe(0);
    expect(t.out).toBe('src/b.ts\n');
    expect(existsSync(join(root, '.ti'))).toBe(false);
  });

  it('emits the JSON dependency shape and honors confidence filtering', async () => {
    const root = project();
    const t = makeIo();
    const code = await dependenciesCommand({
      projectRoot: root,
      io: t.io,
      sources: ['src/a.ts'],
      format: 'json',
      minConfidence: 0.96,
      strict: true,
    });

    expect(code).toBe(0);
    expect(JSON.parse(t.out)).toMatchObject({
      dependencies: [{
        source: 'src/a.ts',
        target: 'src/b.ts',
        partial: false,
        kinds: ['js-import', 'symbol-call'],
      }],
      unknownPaths: [],
    });

    const filtered = makeIo();
    await dependenciesCommand({
      projectRoot: root,
      io: filtered.io,
      sources: ['src/a.ts'],
      format: 'json',
      minConfidence: 0.999,
      strict: true,
    });
    expect(JSON.parse(filtered.out)).toEqual({ dependencies: [], unknownPaths: [] });
  });

  it('reports unknown paths and returns 2 in strict mode', async () => {
    const root = project();
    const t = makeIo();
    const code = await dependenciesCommand({
      projectRoot: root,
      io: t.io,
      sources: ['missing.ts'],
      format: 'json',
      minConfidence: 0,
      strict: true,
    });

    expect(code).toBe(2);
    expect(t.err).toContain('ti: unknown path missing.ts');
    expect(t.out).toBe('');
  });
});
