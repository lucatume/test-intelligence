import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { dispatch } from '../../src/cli/dispatch.js';
import type { Io } from '../../src/cli/io.js';
import { fixedClock } from '../../src/clock.js';
import type { ISODate } from '../../src/types.js';
import { useTmpDir } from '../helpers/tmpDir.js';
import { writeShard, writeIndex } from '../../src/storage/write.js';
import { writeSchemaVersion } from '../../src/storage/schema.js';

function makeIo(opts?: { stdin?: string; isTty?: boolean }): Io & { outbuf: string; errbuf: string } {
  let outbuf = '', errbuf = '';
  const io: Io & { outbuf: string; errbuf: string } = {
    stdout: { write(c) { outbuf += c; (io as { outbuf: string }).outbuf = outbuf; } },
    stderr: { write(c) { errbuf += c; (io as { errbuf: string }).errbuf = errbuf; } },
    readStdin: () => Promise.resolve(opts?.stdin ?? ''),
    stdinIsTty: opts?.isTty ?? true,
    outbuf: '',
    errbuf: '',
  };
  return io;
}

describe('dispatch — help / version', () => {
  it('help command writes HELP_TEXT to stdout and exits 0', async () => {
    const io = makeIo();
    const code = await dispatch({
      argv: ['--help'],
      io,
      cwd: process.cwd(),
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf).toMatch(/USAGE/);
    expect(io.errbuf).toBe('');
  });

  it('version command writes semver to stdout and exits 0', async () => {
    const io = makeIo();
    const code = await dispatch({
      argv: ['--version'],
      io,
      cwd: process.cwd(),
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('unknown command exits 1 with stderr notice', async () => {
    const io = makeIo();
    const code = await dispatch({
      argv: ['wat'],
      io,
      cwd: process.cwd(),
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(1);
    expect(io.errbuf).toMatch(/ti: error:/);
  });
});

describe('dispatch — unlock', () => {
  const tmp = useTmpDir('ti-dispatch-unlock-');

  async function seedProject(pin: number | 'none'): Promise<string> {
    const root = tmp();
    await fs.writeFile(path.join(root, 'ti.config.ts'), 'export default {};');
    const tiDir = path.join(root, '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    if (pin !== 'none') {
      await fs.writeFile(path.join(tiDir, '.lock'), JSON.stringify({
        pid: pin, hostname: os.hostname(), command: 'ti build', startedAt: '2026-04-23T00:00:00Z',
      }));
    }
    return root;
  }

  it('no-op when no lock exists: exit 0 with stderr notice', async () => {
    const root = await seedProject('none');
    const io = makeIo();
    const code = await dispatch({
      argv: ['unlock'],
      io,
      cwd: root,
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.errbuf).toMatch(/no lock/i);
  });

  it('releases a stale (dead-PID) lock: exit 0', async () => {
    const root = await seedProject(0);
    const io = makeIo();
    const code = await dispatch({
      argv: ['unlock'],
      io,
      cwd: root,
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    await expect(fs.access(path.join(root, '.test-intelligence', '.lock'))).rejects.toThrow();
  });

  it('refuses a live-PID lock: exit 1 with LockHeldError message', async () => {
    const root = await seedProject(process.pid);
    const io = makeIo();
    const code = await dispatch({
      argv: ['unlock'],
      io,
      cwd: root,
      clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(1);
    expect(io.errbuf).toMatch(/PID/);
  });
});

async function seedQueryableMap(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'ti.config.ts'), 'export default {};');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'Cart.php'), '<?php class Cart {}');
  const tiDir = path.join(root, '.test-intelligence');
  await fs.mkdir(path.join(tiDir, 'shards'), { recursive: true });
  await fs.mkdir(path.join(tiDir, '.tmp'), { recursive: true });
  await writeSchemaVersion(tiDir, 1);
  const source_hash = `sha1:${crypto.createHash('sha1').update(await fs.readFile(path.join(root, 'src', 'Cart.php'))).digest('hex')}`;
  const shardName = crypto.createHash('sha1').update('src/Cart.php').digest('hex');
  const w1 = await writeShard({
    tiDir,
    shardFilename: `${shardName}.json`,
    content: {
      source: 'src/Cart.php',
      source_hash,
      tests: [
        { id: 'phpunit:tests/CartTest.php::testAdd', file: 'tests/CartTest.php',
          framework: 'phpunit', filter: 'testAdd', confidence: 0.9, stale: undefined,
          evidence: [{ strategy: 'runtime', at: '2026-04-23T00:00:00Z' }] },
      ],
      views: [],
    },
  });
  expect(w1.kind).toBe('ok');
  const w2 = await writeIndex(tiDir, {
    by_test: { 'phpunit:tests/CartTest.php::testAdd': [shardName] },
    by_view: {},
    by_path: { 'src/Cart.php': shardName },
  });
  expect(w2.kind).toBe('ok');
}

describe('dispatch — ti tests --from-sources', () => {
  const tmp = useTmpDir('ti-dispatch-tests-');

  it('emits runner-native args for a known source', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    const io = makeIo();
    const code = await dispatch({
      argv: ['tests', '--from-sources', 'src/Cart.php', '--framework=phpunit'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf).toContain("tests/CartTest.php --filter '^testAdd$'");
  });

  it('--format=json emits the documented JSON shape', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    const io = makeIo();
    const code = await dispatch({
      argv: ['tests', '--from-sources', 'src/Cart.php', '--framework=phpunit', '--format=json'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.outbuf) as { framework: string; tests: unknown[] };
    expect(parsed.framework).toBe('phpunit');
    expect(parsed.tests).toHaveLength(1);
  });

  it('unknown source: stderr warning, stdout empty, exit 0 (empty = "run everything")', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    const io = makeIo();
    const code = await dispatch({
      argv: ['tests', '--from-sources', 'src/missing.ts', '--framework=phpunit'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf).toBe('');
    expect(io.errbuf).toMatch(/unknown/i);
  });

  it('unknown source under --strict: exit 2', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    const io = makeIo();
    const code = await dispatch({
      argv: ['tests', '--from-sources', 'src/missing.ts', '--framework=phpunit', '--strict'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(2);
  });

  it('schema out of range: exit 1', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    await writeSchemaVersion(path.join(root, '.test-intelligence'), 999);
    const io = makeIo();
    const code = await dispatch({
      argv: ['tests', '--from-sources', 'src/Cart.php', '--framework=phpunit'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(1);
    expect(io.errbuf).toMatch(/schema/i);
  });

  it('no map at all: exit 1 with MapNotFoundError', async () => {
    const root = tmp();
    await fs.writeFile(path.join(root, 'ti.config.ts'), 'export default {};');
    const io = makeIo();
    const code = await dispatch({
      argv: ['tests', '--from-sources', 'src/Cart.php', '--framework=phpunit'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(1);
    expect(io.errbuf).toMatch(/ti build/i);
  });

  it('reads newline-delimited sources from stdin when no positionals and stdin is not a TTY', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    const io = makeIo({ stdin: 'src/Cart.php\n', isTty: false });
    const code = await dispatch({
      argv: ['tests', '--from-sources', '--framework=phpunit'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf).toContain("tests/CartTest.php --filter '^testAdd$'");
  });
});

describe('dispatch — ti sources --from-tests', () => {
  const tmp = useTmpDir('ti-dispatch-sources-');

  it('emits newline-separated source paths', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    const io = makeIo();
    const code = await dispatch({
      argv: ['sources', '--from-tests', 'phpunit:tests/CartTest.php::testAdd'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf.trim()).toBe('src/Cart.php');
  });
});

describe('dispatch — ti explain', () => {
  const tmp = useTmpDir('ti-dispatch-explain-');

  it('prints a human summary and exits 0 for a known test id', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    const io = makeIo();
    const code = await dispatch({
      argv: ['explain', 'phpunit:tests/CartTest.php::testAdd'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(0);
    expect(io.outbuf).toContain('phpunit:tests/CartTest.php::testAdd');
  });

  it('exits 1 with "unknown id" for a view-id target', async () => {
    const root = tmp();
    await seedQueryableMap(root);
    const io = makeIo();
    const code = await dispatch({
      argv: ['explain', 'rest:POST /api/v1/cart/items'],
      io, cwd: root, clock: fixedClock('2026-04-23T00:00:00Z' as ISODate),
    });
    expect(code).toBe(1);
    expect(io.errbuf).toMatch(/unknown id/i);
    expect(io.outbuf).toBe('');  // stdout stays clean on error
  });
});
