import { createHash } from 'node:crypto';
import type { UnresolvedExpr } from '../../facts/types.js';

// Stable content hash for an unresolved fact's resolution context. The hash is
// a function of ONLY the enclosing scope and the unresolved expressions' source
// text — never file position — so an unrelated edit elsewhere in the file does
// not re-open the resolution. Fields are sorted by name so emission order does
// not affect the digest. The PHP worker (`buildUnresolvedBlock`) computes the
// identical canonical string and sha256.
export function exprHash(scope: string, fields: readonly UnresolvedExpr[]): string {
  const sorted = [...fields].sort((a, b) =>
    a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
  );
  let canonical = scope + '\n';
  for (const f of sorted) canonical += f.field + '=' + f.expression + '\n';
  return createHash('sha256').update(canonical).digest('hex');
}
