import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhpWorker, hasPhpAvailable } from '../../../src/extract/php/spawn.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe.skipIf(!hasPhpAvailable())('startPhpWorker', () => {
  it('boots and shuts down cleanly', async () => {
    const r = startPhpWorker({ repoRoot });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const pong = await r.value.ping();
      expect(pong).toBe(true);
      await r.value.shutdown();
    }
  });

  it('registers patterns', async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error('worker failed');
    const count = await r.value.registerPatterns([
      { match: { lang: 'php', nodeKind: 'function-call', name: 'add_action' }, bind: { hook: { arg: 0, type: 'string' } }, emit: 'hook-listener' },
    ]);
    expect(count).toBe(1);
    await r.value.shutdown();
  });

  it('reports unknown op as protocol error', async () => {
    const r = startPhpWorker({ repoRoot });
    if (r.kind !== 'ok') throw new Error('worker failed');
    try {
      await expect((r.value as unknown as { ping: () => Promise<boolean> } & { extract: (a: string) => Promise<unknown> }).extract('/nonexistent')).resolves.toBeDefined();
    } finally {
      await r.value.shutdown();
    }
  });
});
