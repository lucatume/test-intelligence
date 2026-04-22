export type Ok<T>  = { readonly kind: 'ok';  readonly value: T };
export type Err<E> = { readonly kind: 'err'; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ kind: 'ok', value });
export const err = <E>(error: E): Err<E> => ({ kind: 'err', error });

export function map<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
  return r.kind === 'ok' ? ok(fn(r.value)) : r;
}

export function mapErr<T, E, F>(r: Result<T, E>, fn: (e: E) => F): Result<T, F> {
  return r.kind === 'err' ? err(fn(r.error)) : r;
}

export function andThen<T, U, E, F>(
  r: Result<T, E>,
  fn: (v: T) => Result<U, F>,
): Result<U, E | F> {
  return r.kind === 'ok' ? fn(r.value) : r;
}

export function unwrapOr<T, E, D>(r: Result<T, E>, def: D): T | D {
  return r.kind === 'ok' ? r.value : def;
}

export function combineAll<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (r.kind === 'err') return r;
    values.push(r.value);
  }
  return ok(values);
}

export function combineWithAllErrors<T, E>(
  results: readonly Result<T, E>[],
): Result<T[], E[]> {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.kind === 'ok') values.push(r.value);
    else errors.push(r.error);
  }
  return errors.length ? err(errors) : ok(values);
}
