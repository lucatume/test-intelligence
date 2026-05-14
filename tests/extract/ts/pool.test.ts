import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startTsWorkerPool } from '../../../src/extract/ts/pool.js';
import { useTmpDir } from '../../helpers/tmpDir.js';

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

// Spawning a worker_thread + loading jiti + importing typescript adds 1-3s
// per worker on first use. The default 5s test timeout is tight; bump it.
describe('startTsWorkerPool', { timeout: 30_000 }, () => {
  const getTmp = useTmpDir('ti-ts-pool-');

  it('boots N workers and shuts them down cleanly', async () => {
    const root = getTmp();
    const pool = startTsWorkerPool({ projectRoot: root, size: 2 });
    await pool.shutdown();
  });

  it('extracts a TS file via the pool', async () => {
    const root = getTmp();
    write(root, 'src/a.ts', `import { b } from './b';\nexport function a(){ b(); }`);
    write(root, 'src/b.ts', `export function b(){}`);
    const pool = startTsWorkerPool({ projectRoot: root, size: 2 });
    try {
      const facts = await pool.extract({
        relPath: 'src/a.ts',
        language: 'ts',
        framework: null,
        source: readFileSync(join(root, 'src/a.ts'), 'utf8'),
        patterns: [],
      });
      // Should produce at least an import-edge fact for './b'.
      const importEdges = facts.filter((f) => f.kind === 'import-edge');
      expect(importEdges.length).toBeGreaterThan(0);
    } finally {
      await pool.shutdown();
    }
  });

  it('produces identical facts to in-process extractTsFile', async () => {
    // The pool path must match the in-process path byte-for-byte. If the
    // worker drops a fact (e.g. parse-error) or reorders them, downstream
    // derive will produce different edges.
    const { extractTsFile } = await import('../../../src/extract/ts/extract.js');
    const { synthesizeCompilerOptions } = await import('../../../src/extract/ts/compiler.js');
    const root = getTmp();
    write(root, 'src/a.ts', `
import { b } from './b';
import * as React from 'react';
export class Foo extends React.Component {}
export function a() { b(); }
`);
    write(root, 'src/b.ts', `export function b() {}`);

    const source = readFileSync(join(root, 'src/a.ts'), 'utf8');
    const compilerOptions = synthesizeCompilerOptions(root);
    const inProcess = await extractTsFile({
      projectRoot: root,
      relPath: 'src/a.ts',
      language: 'ts',
      framework: null,
      compilerOptions,
      patterns: [],
      source,
    });

    const pool = startTsWorkerPool({ projectRoot: root, size: 1 });
    try {
      const viaPool = await pool.extract({
        relPath: 'src/a.ts',
        language: 'ts',
        framework: null,
        source,
        patterns: [],
      });
      expect(viaPool).toEqual(inProcess);
    } finally {
      await pool.shutdown();
    }
  });

  it('dispatches 30 concurrent extracts across pool of 2', async () => {
    const root = getTmp();
    for (let i = 0; i < 30; i++) {
      write(root, `src/f${String(i)}.ts`, `import { x } from './shared'; export function f${String(i)}(){ x(); }`);
    }
    write(root, 'src/shared.ts', `export function x(){}`);
    const pool = startTsWorkerPool({ projectRoot: root, size: 2 });
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => {
          const rel = `src/f${String(i)}.ts`;
          return pool.extract({
            relPath: rel,
            language: 'ts',
            framework: null,
            source: readFileSync(join(root, rel), 'utf8'),
            patterns: [],
          });
        }),
      );
      expect(results.length).toBe(30);
      for (const facts of results) {
        expect(facts.some((f) => f.kind === 'import-edge')).toBe(true);
      }
    } finally {
      await pool.shutdown();
    }
  });
});
