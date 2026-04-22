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

describe('parseProjectRelativePath — rule 4: NUL bytes', () => {
  it('rejects a path containing NUL', () => {
    const r = parseProjectRelativePath('src/a\0.ts', '/tmp');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.reason).toBe('nul-byte');
  });
});

describe('parseProjectRelativePath — rule 5: symlinks', () => {
  let tmpRoot: string;
  let outside: string;
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-paths-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    // Create a symlink inside the project that points OUT of the project.
    await fs.symlink(outside, path.join(tmpRoot, 'link-outside'));
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'src', 'a.ts'), '');
  });

  it('rejects a path that resolves via a symlink to outside the root', () => {
    const r = parseProjectRelativePath('link-outside/secret.txt', tmpRoot, { allowSymlinkTargets: [] });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.reason).toBe('symlink-escapes-root');
  });

  it('allows symlinks listed in allowSymlinkTargets', () => {
    const r = parseProjectRelativePath('link-outside/secret.txt', tmpRoot, {
      allowSymlinkTargets: [outside],
    });
    expect(r.kind).toBe('ok');
  });

  it('allows a regular file (no symlink) inside the project', () => {
    const r = parseProjectRelativePath('src/a.ts', tmpRoot, { allowSymlinkTargets: [] });
    expect(r.kind).toBe('ok');
  });
});

describe('parseProjectRelativePath — rule 6: never throws', () => {
  it('returns Result.err for a truly pathological input instead of throwing', () => {
    const r = parseProjectRelativePath('\0', '/tmp');
    expect(r.kind).toBe('err');
  });
});

describe('parseProjectRelativePath — empty input', () => {
  it('rejects an empty string', () => {
    const r = parseProjectRelativePath('', '/tmp');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.reason).toBe('empty');
  });
});
