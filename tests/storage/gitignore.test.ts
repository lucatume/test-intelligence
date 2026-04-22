import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ensureGitignore } from '../../src/storage/gitignore.js';
import { useTmpDir } from '../helpers/tmpDir.js';

describe('ensureGitignore', () => {
  const tmp = useTmpDir('ti-gi-');

  it('creates the file when missing', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await ensureGitignore(tiDir);
    const content = await fs.readFile(path.join(tiDir, '.gitignore'), 'utf8');
    expect(content).toContain('.lock');
    expect(content).toContain('.tmp/');
    expect(content).toContain('# --- ti-managed above; user entries below ---');
  });

  it('preserves user entries below the sentinel', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    const initial = [
      '# Managed by ti — do not edit these entries.',
      '# You can add your own entries below the sentinel line.',
      '.lock',
      '.tmp/',
      '# --- ti-managed above; user entries below ---',
      'my-user-file.json',
    ].join('\n') + '\n';
    await fs.writeFile(path.join(tiDir, '.gitignore'), initial);
    await ensureGitignore(tiDir);
    const content = await fs.readFile(path.join(tiDir, '.gitignore'), 'utf8');
    expect(content).toContain('my-user-file.json');
  });

  it('adds a sentinel when missing and keeps the existing content as user-owned', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await fs.writeFile(path.join(tiDir, '.gitignore'), 'legacy-user-entry\n');
    await ensureGitignore(tiDir);
    const content = await fs.readFile(path.join(tiDir, '.gitignore'), 'utf8');
    expect(content).toContain('.lock');
    expect(content).toContain('.tmp/');
    expect(content).toContain('legacy-user-entry');
    expect(content).toContain('# --- ti-managed above; user entries below ---');
  });

  it('rewrites the managed section idempotently', async () => {
    const tiDir = path.join(tmp(), '.test-intelligence');
    await fs.mkdir(tiDir, { recursive: true });
    await ensureGitignore(tiDir);
    const first = await fs.readFile(path.join(tiDir, '.gitignore'), 'utf8');
    await ensureGitignore(tiDir);
    const second = await fs.readFile(path.join(tiDir, '.gitignore'), 'utf8');
    expect(second).toBe(first);
  });
});
