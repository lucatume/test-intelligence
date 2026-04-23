import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

export type HashError = { readonly kind: 'HashError'; readonly message: string; readonly file: string };

export async function computeSourceHash(
  absolutePath: string,
): Promise<Result<string, HashError>> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absolutePath);
  } catch (e) {
    return err({
      kind: 'HashError',
      message: `could not read ${absolutePath}: ${e instanceof Error ? e.message : String(e)}`,
      file: absolutePath,
    });
  }
  const hex = crypto.createHash('sha1').update(bytes).digest('hex');
  return ok(`sha1:${hex}`);
}
