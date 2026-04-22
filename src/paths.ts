import * as path from 'node:path';
import { ok, err } from './result.js';
import type { Result } from './result.js';
import type { ProjectRelativePath } from './types.js';

export type PathParseError =
  | { readonly reason: 'absolute'; readonly input: string }
  | { readonly reason: 'escapes-root'; readonly input: string; readonly projectRoot: string }
  | { readonly reason: 'nul-byte'; readonly input: string }
  | { readonly reason: 'symlink-escapes-root'; readonly input: string; readonly target: string }
  | { readonly reason: 'empty'; readonly input: string };

export function parseProjectRelativePath(
  input: string,
  projectRoot: string,
): Result<ProjectRelativePath, PathParseError> {
  if (input === '') {
    return err({ reason: 'empty', input });
  }
  // Rule 1: reject absolute paths (POSIX and Windows).
  if (path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    return err({ reason: 'absolute', input });
  }
  // Rule 4 (partial): NUL byte check — cheap, do it early.
  if (input.includes('\0')) {
    return err({ reason: 'nul-byte', input });
  }
  // Rule 2: normalize.
  const normalizedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(normalizedRoot, input);
  // Rule 3: containment.
  const rel = path.relative(normalizedRoot, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return err({ reason: 'escapes-root', input, projectRoot: normalizedRoot });
  }
  // Return a forward-slash, POSIX-style relative path as the canonical brand value.
  const canonical = rel.split(path.sep).join('/');
  return ok(canonical as ProjectRelativePath);
}
