import { ok, err } from './result.js';
import type { Result } from './result.js';
import type { FrameworkName, TestFilePath } from './types.js';
import { parseProjectRelativePath } from './paths.js';
import type { PathParseError, PathParseOptions } from './paths.js';

export type TestId = {
  readonly framework: FrameworkName;
  readonly file: TestFilePath;
  readonly filter?: string; // method / test-name pattern, absent for file-scope ids
};

export type IdParseError =
  | { readonly reason: 'malformed'; readonly input: string }
  | { readonly reason: 'unknown-framework'; readonly input: string; readonly found: string }
  | { readonly reason: 'path-invalid'; readonly input: string; readonly cause: PathParseError };

const KNOWN: readonly FrameworkName[] = ['phpunit', 'jest', 'playwright'];

export function parseTestId(
  raw: string,
  projectRoot: string,
  options: PathParseOptions = {},
): Result<TestId, IdParseError> {
  const firstColon = raw.indexOf(':');
  if (firstColon <= 0) {
    return err({ reason: 'malformed', input: raw });
  }
  const fw = raw.slice(0, firstColon);
  const rest = raw.slice(firstColon + 1);
  // A framework name is a simple identifier — no slashes, dots, or spaces.
  // If the candidate contains path-like characters it means the input has no
  // framework prefix at all, so treat it as malformed rather than unknown-framework.
  if (/[/\\. ]/.test(fw)) {
    return err({ reason: 'malformed', input: raw });
  }
  if (!(KNOWN as readonly string[]).includes(fw)) {
    return err({ reason: 'unknown-framework', input: raw, found: fw });
  }
  const filterIdx = rest.indexOf('::');
  const pathPart = filterIdx === -1 ? rest : rest.slice(0, filterIdx);
  const filter = filterIdx === -1 ? undefined : rest.slice(filterIdx + 2);
  if (pathPart === '') {
    return err({ reason: 'malformed', input: raw });
  }
  const pathResult = parseProjectRelativePath(pathPart, projectRoot, options);
  if (pathResult.kind === 'err') {
    return err({ reason: 'path-invalid', input: raw, cause: pathResult.error });
  }
  return ok({
    framework: fw as FrameworkName,
    file: pathResult.value as unknown as TestFilePath,
    ...(filter !== undefined ? { filter } : {}),
  });
}

export function formatTestId(id: TestId): string {
  return id.filter === undefined
    ? `${id.framework}:${id.file}`
    : `${id.framework}:${id.file}::${id.filter}`;
}
