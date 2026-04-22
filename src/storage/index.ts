import * as P from '../parse.js';
import type { Infer, ParseResult } from '../parse.js';

const indexSchema = P.object({
  by_test: P.record(P.array(P.string)),
  by_view: P.record(P.array(P.string)),
  by_path: P.record(P.string),
});

export type Index = Infer<typeof indexSchema>;

export function parseIndex(raw: unknown): ParseResult<Index> {
  return indexSchema.parse(raw);
}
