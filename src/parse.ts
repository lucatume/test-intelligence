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

export function array<T>(elem: Schema<T>): Schema<T[]> {
  return {
    parse(input) {
      if (!Array.isArray(input)) {
        return err([{ path: [], message: `expected array, got ${typeName(input)}` }]);
      }
      const values: T[] = [];
      const errors: ValidationError[] = [];
      for (let i = 0; i < input.length; i++) {
        const r = nest(elem, input[i], i);
        if (r.kind === 'ok') values.push(r.value);
        else errors.push(...r.error);
      }
      return errors.length ? err(errors) : ok(values);
    },
  };
}

export function record<V>(value: Schema<V>): Schema<Record<string, V>> {
  return {
    parse(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return err([{ path: [], message: `expected object, got ${typeName(input)}` }]);
      }
      const out: Record<string, V> = {};
      const errors: ValidationError[] = [];
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        const r = nest(value, v, k);
        if (r.kind === 'ok') out[k] = r.value;
        else errors.push(...r.error);
      }
      return errors.length ? err(errors) : ok(out);
    },
  };
}

export function enumOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return {
    parse(input) {
      if (typeof input === 'string' && (values as readonly string[]).includes(input)) {
        return ok(input as T[number]);
      }
      const render = typeof input === 'string' ? `"${input}"` : String(input);
      return err([{
        path: [],
        message: `expected one of [${values.join(', ')}], got ${render}`,
      }]);
    },
  };
}

// Marker type for optional schemas so object() can distinguish them.
type OptionalSchema<T> = Schema<T | undefined> & { readonly __optional: true };
type DefaultedSchema<T> = Schema<T> & { readonly __defaulted: true };

export function optional<T>(s: Schema<T>): OptionalSchema<T> {
  return {
    parse(input) {
      if (input === undefined) return ok(undefined);
      return s.parse(input);
    },
    __optional: true,
  };
}

export function withDefault<T>(s: Schema<T>, defaultValue: T): DefaultedSchema<T> {
  return {
    parse(input) {
      if (input === undefined) return ok(defaultValue);
      return s.parse(input);
    },
    __defaulted: true,
  };
}

export function refine<T>(
  upstream: Schema<T>,
  check: (v: T) => string | null,
): Schema<T> {
  return {
    parse(input) {
      const r = upstream.parse(input);
      if (r.kind === 'err') return r;
      const msg = check(r.value);
      if (msg === null) return r;
      return err([{ path: [], message: msg }]);
    },
  };
}

type ObjectShape = Record<string, Schema<unknown>>;

// Output type helper: gives each field its T, with optional-schema fields widened to T | undefined.
type ShapeOutput<S extends ObjectShape> = {
  [K in keyof S]: S[K] extends OptionalSchema<infer T> ? T | undefined
    : S[K] extends DefaultedSchema<infer T> ? T
    : S[K] extends Schema<infer T> ? T
    : never;
};

export function object<S extends ObjectShape>(shape: S): Schema<ShapeOutput<S>> {
  const keys = Object.keys(shape);
  return {
    parse(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return err([{ path: [], message: `expected object, got ${typeName(input)}` }]);
      }
      const obj = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const errors: ValidationError[] = [];
      for (const k of keys) {
        // k is always a key of shape since we built keys from Object.keys(shape)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const fieldSchema = shape[k]!;
        const value = obj[k];
        const isOptional = '__optional' in fieldSchema;
        const hasDefault = '__defaulted' in fieldSchema;
        if (value === undefined && !isOptional && !hasDefault) {
          errors.push({ path: [k], message: 'missing required field' });
          continue;
        }
        const r = nest(fieldSchema, value, k);
        if (r.kind === 'err') {
          errors.push(...r.error);
          continue;
        }
        if (r.value !== undefined || !isOptional) {
          out[k] = r.value;
        }
      }
      return errors.length ? err(errors) : ok(out as ShapeOutput<S>);
    },
  };
}

// Internal export kept for potential use by consumers needing path-qualified parsing.
export const _internal = { nest };
