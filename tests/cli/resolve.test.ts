import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveCommand } from '../../src/cli/commands/resolve.js';
import { applyInitialSchema } from '../../src/store/migrations.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor } from '../../src/store/writers.js';
import Database from 'better-sqlite3';
import { useTmpDir } from '../helpers/tmpDir.js';
import type { Io } from '../../src/cli/io.js';

function captureIo(): Io & { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    stdout: { write: (c: string) => { out += c; } },
    stderr: { write: (c: string) => { err += c; } },
    readStdin: () => Promise.resolve(''),
    stdinIsTty: false,
    out: () => out,
    err: () => err,
  };
}

// Build a real .ti store under `root` with one unresolved hook-fire fact and a
// backing `inc.php` whose line 12 contains the token `save_post`.
function seedProject(root: string, exprHash: string): void {
  const incPath = join(root, 'inc.php');
  mkdirSync(dirname(incPath), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(i === 12 ? "add_action( 'save_post', 'cb' );" : `// line ${String(i)}`);
  }
  writeFileSync(incPath, lines.join('\n') + '\n');

  mkdirSync(join(root, '.ti'), { recursive: true });
  const db = new Database(join(root, '.ti', 'store.db'));
  applyInitialSchema(db);
  const fileId = upsertFile(db, {
    path: 'inc.php', language: 'php', contentHash: 'fh',
    extractedAt: '2026-05-17T00:00:00.000Z', isTest: false,
    framework: null, frameworkClass: null,
  });
  const broad = upsertAnchor(db, { key: 'hook:{*}', type: 'hook' });
  const factId = insertFact(db, {
    fileId, kind: 'hook-fire', resolved: false, startLine: 14, endLine: 14,
    payload: {
      kind: 'hook-fire', hook: '{*}',
      unresolved: { scope: '(file)', fields: [{ field: 'hook', expression: '$hook' }], exprHash },
    },
  });
  insertFactAnchor(db, { factId, anchorId: broad, role: 'subject' });
  db.close();
}

// Seed `count` unresolved hook-fire facts in one backing file.
function seedManyHookFacts(root: string, count: number): void {
  const incPath = join(root, 'inc.php');
  mkdirSync(dirname(incPath), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= count + 20; i++) lines.push(`do_action( $hook ); // line ${String(i)}`);
  writeFileSync(incPath, lines.join('\n') + '\n');

  mkdirSync(join(root, '.ti'), { recursive: true });
  const db = new Database(join(root, '.ti', 'store.db'));
  applyInitialSchema(db);
  const fileId = upsertFile(db, {
    path: 'inc.php', language: 'php', contentHash: 'fh',
    extractedAt: '2026-05-17T00:00:00.000Z', isTest: false,
    framework: null, frameworkClass: null,
  });
  const broad = upsertAnchor(db, { key: 'hook:{*}', type: 'hook' });
  for (let i = 0; i < count; i++) {
    const factId = insertFact(db, {
      fileId, kind: 'hook-fire', resolved: false,
      startLine: 5 + i, endLine: 5 + i,
      payload: {
        kind: 'hook-fire', hook: '{*}',
        unresolved: { scope: '(file)', fields: [{ field: 'hook', expression: '$hook' }], exprHash: `h${String(i)}` },
      },
    });
    insertFactAnchor(db, { factId, anchorId: broad, role: 'subject' });
  }
  db.close();
}

describe('ti resolve', () => {
  const getTmp = useTmpDir('ti-cli-resolve-');

  it('export -> import -> status round-trips on a fixture store', async () => {
    const root = getTmp();
    seedProject(root, 'h1');
    const rxPath = join(root, 'rx.json');
    const io = captureIo();
    mkdirSync(join(root, 'out'), { recursive: true });

    const expCode = await resolveCommand({
      projectRoot: root, io, sub: 'export',
      kinds: ['hook-fire', 'hook-listener'], limit: 50, force: false,
      out: join(root, 'out', 'prompt'),
    });
    expect(expCode).toBe(0);

    // The emitted prompt is a self-contained markdown artifact.
    const prompt = readFileSync(join(root, 'out', 'prompt-001.md'), 'utf8');
    expect(prompt).toContain('## Task');
    expect(prompt).toMatch(/cite/i);
    expect(prompt).toContain('## Unit h1');
    expect(prompt).toContain('## Output format');

    writeFileSync(rxPath, JSON.stringify({
      version: 1, pass: 'llm', resolutions: [{
        exprHash: 'h1', classification: 'structural-rule',
        resolvedValue: { hookName: 'save_post' },
        citation: { path: 'inc.php', line: 12 },
      }],
    }));

    const impCode = await resolveCommand({ projectRoot: root, io, sub: 'import', input: rxPath });
    expect(impCode).toBe(0);
    expect(io.out()).toContain('applied');

    const statCode = await resolveCommand({ projectRoot: root, io, sub: 'status' });
    expect(statCode).toBe(0);
  });

  it('export writes one chunked prompt file per batch', async () => {
    const root = getTmp();
    seedManyHookFacts(root, 120);
    mkdirSync(join(root, 'out'), { recursive: true });
    const code = await resolveCommand({
      projectRoot: root, io: captureIo(), sub: 'export',
      kinds: ['hook-fire', 'hook-listener'], limit: 50, force: false,
      out: join(root, 'out', 'prompt'),
    });
    expect(code).toBe(0);
    expect(readFileSync(join(root, 'out', 'prompt-001.md'), 'utf8')).toContain('## Task');
    expect(readFileSync(join(root, 'out', 'prompt-002.md'), 'utf8')).toContain('## Task');
    expect(readFileSync(join(root, 'out', 'prompt-003.md'), 'utf8')).toContain('## Task');
  });

  it('export emits a single file when units fit one batch', async () => {
    const root = getTmp();
    seedManyHookFacts(root, 10);
    mkdirSync(join(root, 'out'), { recursive: true });
    const code = await resolveCommand({
      projectRoot: root, io: captureIo(), sub: 'export',
      kinds: ['hook-fire', 'hook-listener'], limit: 50, force: false,
      out: join(root, 'out', 'prompt'),
    });
    expect(code).toBe(0);
    const p = readFileSync(join(root, 'out', 'prompt-001.md'), 'utf8');
    expect(p).toContain('## Task');
    expect(p).toContain('batch 1 of 1');
    expect(() => readFileSync(join(root, 'out', 'prompt-002.md'), 'utf8')).toThrow();
  });

  it('export with zero unresolved facts writes no files, exits 0', async () => {
    const root = getTmp();
    mkdirSync(join(root, '.ti'), { recursive: true });
    const db = new Database(join(root, '.ti', 'store.db'));
    applyInitialSchema(db);
    db.close();
    mkdirSync(join(root, 'out'), { recursive: true });
    const io = captureIo();
    const code = await resolveCommand({
      projectRoot: root, io, sub: 'export',
      kinds: ['hook-fire', 'hook-listener'], limit: 50, force: false,
      out: join(root, 'out', 'prompt'),
    });
    expect(code).toBe(0);
    expect(io.out()).toMatch(/nothing to resolve/i);
  });

  it('import of a malformed file exits 2', async () => {
    const root = getTmp();
    seedProject(root, 'h1');
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{ not valid');
    const code = await resolveCommand({ projectRoot: root, io: captureIo(), sub: 'import', input: bad });
    expect(code).toBe(2);
  });

  it('import of a schema-invalid file exits 2', async () => {
    const root = getTmp();
    seedProject(root, 'h1');
    const bad = join(root, 'bad2.json');
    writeFileSync(bad, JSON.stringify({ version: 9, pass: 'llm', resolutions: [] }));
    const code = await resolveCommand({ projectRoot: root, io: captureIo(), sub: 'import', input: bad });
    expect(code).toBe(2);
  });

  it('export with an unsupported kind exits 1', async () => {
    const root = getTmp();
    seedProject(root, 'h1');
    const code = await resolveCommand({
      projectRoot: root, io: captureIo(), sub: 'export',
      kinds: ['rest-call-js'] as never, limit: 50, force: false,
      out: join(root, 'b'),
    });
    expect(code).toBe(1);
  });
});
