import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { resolveProjectRoot } from '../../src/config/resolve.js';

describe('resolveProjectRoot', () => {
  let root: string;
  let deep: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-resolve-'));
    deep = path.join(root, 'a', 'b', 'c');
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(root, 'ti.config.ts'), 'export default {};');
  });

  it('finds ti.config.ts in the current directory', async () => {
    const r = await resolveProjectRoot(root);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(path.resolve(r.value.projectRoot)).toBe(path.resolve(root));
      expect(r.value.configFile.endsWith('ti.config.ts')).toBe(true);
    }
  });

  it('walks up from a deep subdirectory', async () => {
    const r = await resolveProjectRoot(deep);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(path.resolve(r.value.projectRoot)).toBe(path.resolve(root));
  });

  it('prefers .ts over .js/.mjs when multiple exist', async () => {
    const mixed = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-mixed-'));
    await fs.writeFile(path.join(mixed, 'ti.config.ts'), '');
    await fs.writeFile(path.join(mixed, 'ti.config.js'), '');
    await fs.writeFile(path.join(mixed, 'ti.config.mjs'), '');
    const r = await resolveProjectRoot(mixed);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.configFile.endsWith('.ts')).toBe(true);
  });

  it('returns a ConfigError when no config is found up to filesystem root', async () => {
    // Use /tmp directly, which won't have a ti.config.* above it.
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-isolated-'));
    const r = await resolveProjectRoot(isolated);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.kind).toBe('ConfigError');
  });
});
