import * as path from 'node:path';
import * as fs from 'node:fs';
import { ok, err } from './result.js';
import type { Result } from './result.js';
import type { ProjectRelativePath } from './types.js';

export type PathParseError =
  | { readonly reason: 'absolute'; readonly input: string }
  | { readonly reason: 'escapes-root'; readonly input: string; readonly projectRoot: string }
  | { readonly reason: 'nul-byte'; readonly input: string }
  | { readonly reason: 'symlink-escapes-root'; readonly input: string; readonly target: string }
  | { readonly reason: 'empty'; readonly input: string };

export type PathParseOptions = {
  /** Allowlisted symlink target roots; targets under any listed root are accepted. */
  readonly allowSymlinkTargets?: readonly string[];
};

export function parseProjectRelativePath(
  input: string,
  projectRoot: string,
  options: PathParseOptions = {},
): Result<ProjectRelativePath, PathParseError> {
  if (input === '') {
    return err({ reason: 'empty', input });
  }
  if (path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    return err({ reason: 'absolute', input });
  }
  if (input.includes('\0')) {
    return err({ reason: 'nul-byte', input });
  }
  const normalizedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(normalizedRoot, input);
  const rel = path.relative(normalizedRoot, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return err({ reason: 'escapes-root', input, projectRoot: normalizedRoot });
  }
  // Rule 5: symlink-target containment.
  // Only check if the path (or any ancestor) exists and contains symlinks.
  // If the path doesn't exist yet, there are no symlinks to worry about.
  try {
    const realPath = fs.realpathSync(resolved);
    // On macOS, /var/folders/... realpath resolves to /private/var/folders/...
    // so we must compare using realpathSync(normalizedRoot) to stay in the
    // same symlink-resolved universe.
    const realRoot = fs.realpathSync(normalizedRoot);
    const realRel = path.relative(realRoot, realPath);
    if (realRel !== '' && (realRel.startsWith('..') || path.isAbsolute(realRel))) {
      // Target is outside the root. Check the allowlist.
      const allow = options.allowSymlinkTargets ?? [];
      const realResolved = path.resolve(realPath);
      const allowed = allow.some((a) => {
        const allowRoot = fs.realpathSync(path.resolve(a));
        const r = path.relative(allowRoot, realResolved);
        return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
      });
      if (!allowed) {
        return err({ reason: 'symlink-escapes-root', input, target: realResolved });
      }
    }
  } catch {
    // realpathSync throws if the path doesn't exist yet. That's fine —
    // a nonexistent path cannot be a dangerous symlink, and higher layers
    // will handle "file not found" semantics.
  }
  const canonical = rel.split(path.sep).join('/');
  return ok(canonical as ProjectRelativePath);
}
