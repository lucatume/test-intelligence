import { describe, it, expect } from 'vitest';
import { migrateCommand } from '../../../src/cli/commands/migrate.js';
import { useTmpDir } from '../../helpers/tmpDir.js';
import { makeIo } from '../_helpers/makeIo.js';

describe('migrateCommand', () => {
  const getTmp = useTmpDir('ti-migrate-');

  it('exits 0 with already-current message', () => {
    const root = getTmp();
    const t = makeIo();
    expect(migrateCommand({ projectRoot: root, io: t.io })).toBe(0);
    expect(t.err).toMatch(/already at v/);
  });
});
