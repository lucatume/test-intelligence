import { createHash } from 'node:crypto';

// sha1 hex of the UTF-8 file text. The single source of truth for the value
// written to `file.content_hash` and the value the incremental-skip check
// compares against — keeping both on this helper stops the two from drifting.
export function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
