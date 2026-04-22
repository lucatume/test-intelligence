import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { loadConfigFile } from '../../src/config/load.js';

describe('loadConfigFile — .ts', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-load-'));
  });

  it('loads a ti.config.ts using defineConfig', async () => {
    const cfg = path.join(tmp, 'ti.config.ts');
    await fs.writeFile(cfg, `
      export default { frameworks: { jest: { runner: { bin: 'npx', args: ['jest'] } } } };
    `);
    const r = await loadConfigFile(cfg);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const v = r.value as { frameworks?: { jest?: { runner?: unknown } } };
      expect(v.frameworks?.jest?.runner).toEqual({ bin: 'npx', args: ['jest'] });
    }
  });

  it('loads a ti.config.mjs', async () => {
    const cfg = path.join(tmp, 'ti.config.mjs');
    await fs.writeFile(cfg, `
      export default { confidence: { runtime: 1, static: 0.5, heuristic: 0.1 } };
    `);
    const r = await loadConfigFile(cfg);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect((r.value as { confidence?: unknown }).confidence).toBeDefined();
  });

  it('returns ConfigError when the file has no default export', async () => {
    const cfg = path.join(tmp, 'no-default.mjs');
    await fs.writeFile(cfg, `export const x = 1;`);
    const r = await loadConfigFile(cfg);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.kind).toBe('ConfigError');
      expect(r.error.message).toMatch(/default export/i);
    }
  });

  it('returns ConfigError when the file throws on load', async () => {
    const cfg = path.join(tmp, 'throws.mjs');
    await fs.writeFile(cfg, `throw new Error('boom from config');`);
    const r = await loadConfigFile(cfg);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.kind).toBe('ConfigError');
      expect(r.error.message).toMatch(/boom from config/);
    }
  });
});
