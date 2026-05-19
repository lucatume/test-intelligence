import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../../src/build/run.js';
import { parseConfig } from '../../src/config/parse.js';
import { systemClock } from '../../src/clock.js';
import { openStore } from '../../src/store/open.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe('runBuild — jsresolve pass', () => {
  const getTmp = useTmpDir('ti-build-jsresolve-');

  it('resolves an ajax-call-js fact whose action is imported from another module', async () => {
    // The extractor leaves ajax-call-js unresolved when the action argument is
    // an identifier (not an inline literal). runJsResolve must resolve it
    // cross-file and flip resolved=1 with the correct anchor.
    const root = getTmp();

    // The action constant lives in a separate module so the per-file extractor
    // cannot inline it; this forces the cross-file pass to resolve it.
    write(root, 'src/constants.ts', `export const MY_ACTION = 'my_action';`);
    write(root, 'src/client.ts', `
import { MY_ACTION } from './constants';
wp.ajax.post(MY_ACTION, {});
`);

    const cfgRes = parseConfig({ confidence: { threshold: 0 } });
    if (cfgRes.kind === 'err') throw new Error('cfg');

    const r = await runBuild({
      projectRoot: root,
      config: cfgRes.value,
      clock: systemClock,
      stderr: { write: () => {} },
      repoRoot,
    });
    expect(r.kind).toBe('ok');

    const sRes = openStore(root);
    if (sRes.kind !== 'ok') throw new Error('store');
    try {
      const fact = sRes.value.db
        .prepare(`SELECT resolved FROM fact WHERE kind = 'ajax-call-js'`)
        .get() as { resolved: number } | undefined;
      expect(fact).toBeDefined();
      expect(fact?.resolved).toBe(1);

      const anchor = sRes.value.db
        .prepare(`SELECT a.key FROM fact f
                  JOIN fact_anchor fa ON fa.fact_id = f.id
                  JOIN anchor a ON a.id = fa.anchor_id
                  WHERE f.kind = 'ajax-call-js'`)
        .get() as { key: string } | undefined;
      expect(anchor?.key).toBe('ajax:my_action');
    } finally {
      sRes.value.close();
    }
  });
});
