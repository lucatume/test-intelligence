import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { useTmpDir } from '../../helpers/tmpDir.js';
import { emitCoreAdminEntryPointFacts, type CoreAnchorFactInsert } from '../../../src/extract/php/wp-bootstrap.js';

function write(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src);
}

describe('PHP wp-bootstrap emits anchors for core wp-admin entry-points', () => {
  const getTmp = useTmpDir('ti-wp-bootstrap-');

  it('emits one admin-page-register fact per discovered core file', async () => {
    const root = getTmp();
    write(root, 'src/wp-admin/edit.php',     '<?php // core');
    write(root, 'src/wp-admin/post-new.php', '<?php // core');
    write(root, 'src/wp-login.php',          '<?php // core');
    const facts: readonly CoreAnchorFactInsert[] = await emitCoreAdminEntryPointFacts({ projectRoot: root });
    const anchors = facts.flatMap((f) => f.anchors.map((a) => a.key)).sort();
    expect(anchors).toContain('wp-admin-page:edit.php');
    expect(anchors).toContain('wp-admin-page:post-new.php');
    expect(anchors).toContain('wp-frontend:login');
  });

  it('emits nothing when the core files are absent (woocommerce / wp-calypso shape)', async () => {
    const root = getTmp();
    write(root, 'plugins/woocommerce/woocommerce.php', '<?php');
    const facts = await emitCoreAdminEntryPointFacts({ projectRoot: root });
    expect(facts).toEqual([]);
  });
});
