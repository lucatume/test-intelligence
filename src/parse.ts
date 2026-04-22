import { ok, err } from './result.js';
import type { Result } from './result.js';

// A ValidationError is a path-qualified message. `path` identifies where in
// the input tree the error occurred (e.g., ['frameworks', 'phpunit', 'runner', 'bin']).
export type ValidationError = {
  readonly path: readonly (string | number)[];
  readonly message: string;
};

export type ParseResult<T> = Result<T, ValidationError[]>;

export interface Schema<T> {
  parse(input: unknown): ParseResult<T>;
}

// Internal: run a parser and prepend a path segment to any errors it produces.
// Used by object and array parsers to qualify field/index errors.
function nest<T>(
  schema: Schema<T>,
  input: unknown,
  segment: string | number,
): ParseResult<T> {
  const r = schema.parse(input);
  if (r.kind === 'ok') return r;
  return err(
    r.error.map((e) => ({ path: [segment, ...e.path], message: e.message })),
  );
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export const string: Schema<string> = {
  parse(input) {
    if (typeof input === 'string') return ok(input);
    return err([{ path: [], message: `expected string, got ${typeName(input)}` }]);
  },
};

export const number: Schema<number> = {
  parse(input) {
    if (typeof input !== 'number') {
      return err([{ path: [], message: `expected number, got ${typeName(input)}` }]);
    }
    if (Number.isNaN(input)) {
      return err([{ path: [], message: 'expected finite number, got NaN' }]);
    }
    if (!Number.isFinite(input)) {
      return err([{
        path: [],
        message: `expected finite number, got ${input > 0 ? 'Infinity' : '-Infinity'}`,
      }]);
    }
    return ok(input);
  },
};

export const boolean: Schema<boolean> = {
  parse(input) {
    if (typeof input === 'boolean') return ok(input);
    return err([{ path: [], message: `expected boolean, got ${typeName(input)}` }]);
  },
};

// Internal export for use by other parsers in this file.
export const _internal = { nest };
