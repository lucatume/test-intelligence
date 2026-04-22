import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { parseProjectRelativePath } from '../src/paths.js';

describe('parseProjectRelativePath — rule 1: reject absolute', () => {
  it('rejects a POSIX absolute path', () => {
    const r = parseProjectRelativePath('/etc/passwd', '/home/user/project');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.reason).toBe('absolute');
  });

  it('rejects a Windows absolute path on a win-like root', () => {
    const r = parseProjectRelativePath('C:\\Windows\\System32', 'C:\\project');
    expect(r.kind).toBe('err');
  });
});

describe('parseProjectRelativePath — rule 2: normalize', () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-paths-'));
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'src', 'a.ts'), '');
  });

  it('resolves "." segments', () => {
    const r = parseProjectRelativePath('./src/./a.ts', tmpRoot);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(String(r.value)).toBe(path.join('src', 'a.ts'));
  });

  it('collapses redundant separators', () => {
    const r = parseProjectRelativePath('src//a.ts', tmpRoot);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(String(r.value)).toBe(path.join('src', 'a.ts'));
  });
});

describe('parseProjectRelativePath — rule 3: project-root containment', () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-paths-'));
  });

  it('rejects a path escaping via ..', () => {
    const r = parseProjectRelativePath('../other/file.ts', tmpRoot);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.reason).toBe('escapes-root');
  });

  it('rejects deeper .. chains', () => {
    const r = parseProjectRelativePath('src/../../../etc/passwd', tmpRoot);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.reason).toBe('escapes-root');
  });
});
