import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

// Gives each test a fresh temp directory. Use like:
//   const getTmp = useTmpDir('ti-feature-');
//   // inside a test:  const root = getTmp();
export function useTmpDir(prefix: string): () => string {
  let current = '';
  beforeEach(async () => {
    current = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  afterEach(async () => {
    if (current) {
      await fs.rm(current, { recursive: true, force: true });
      current = '';
    }
  });
  return () => current;
}
