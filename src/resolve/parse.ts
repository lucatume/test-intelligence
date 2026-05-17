// The single `unknown` -> typed boundary for the two `resolve` JSON
// contracts. The hallucination guard is structural and lives here: a
// resolution that is not `data-dependent-unresolvable` MUST carry both a
// `resolvedValue` and a `citation`; one that IS must carry neither.
import { ok, err, type Result } from '../result.js';
import { parseProjectRelativePath } from '../paths.js';
import type { ProjectRelativePath } from '../types.js';
import type {
  ResolveBundle, ResolveUnit, ResolutionsFile, Resolution, ResolveError,
  Classification, FactKind,
} from './types.js';

const FACT_KINDS: ReadonlySet<string> = new Set<FactKind>(['hook-fire', 'hook-listener']);
const CLASSES: ReadonlySet<string> = new Set<Classification>([
  'structural-rule', 'project-constant', 'data-dependent-unresolvable',
]);

function fail<T>(message: string): Result<T, ResolveError> {
  return err({ kind: 'parse', message });
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// A pure relative-path check: rejects absolute paths, NUL bytes and `..`
// escapes. `parseProjectRelativePath` is run with `/` as the root — with that
// root no relative input can escape, so the call degenerates to a structural
// validation with no filesystem dependency.
function relativePath(input: unknown, where: string): Result<string, ResolveError> {
  if (typeof input !== 'string') return fail(`${where}: expected string`);
  const r = parseProjectRelativePath(input, '/');
  if (r.kind === 'err') return fail(`${where}: invalid path (${r.error.reason})`);
  return ok(r.value);
}

export function parseResolveBundle(raw: unknown): Result<ResolveBundle, ResolveError> {
  if (!isObject(raw)) return fail('bundle: expected object');
  if (raw['version'] !== 1) return fail('bundle.version: expected 1');
  if (raw['pass'] !== 'llm') return fail('bundle.pass: expected "llm"');
  if (typeof raw['project'] !== 'string') return fail('bundle.project: expected string');
  if (typeof raw['generatedAt'] !== 'string') return fail('bundle.generatedAt: expected string');
  if (!Array.isArray(raw['units'])) return fail('bundle.units: expected array');

  const units: ResolveUnit[] = [];
  for (let i = 0; i < raw['units'].length; i++) {
    const u: unknown = raw['units'][i];
    const at = `bundle.units[${String(i)}]`;
    if (!isObject(u)) return fail(`${at}: expected object`);
    if (typeof u['exprHash'] !== 'string' || u['exprHash'] === '') {
      return fail(`${at}.exprHash: expected non-empty string`);
    }
    if (typeof u['factKind'] !== 'string' || !FACT_KINDS.has(u['factKind'])) {
      return fail(`${at}.factKind: expected hook-fire | hook-listener`);
    }
    if (typeof u['unresolvedExpression'] !== 'string') {
      return fail(`${at}.unresolvedExpression: expected string`);
    }
    if (typeof u['enclosingScope'] !== 'string') {
      return fail(`${at}.enclosingScope: expected string`);
    }
    const fp = relativePath(u['filePath'], `${at}.filePath`);
    if (fp.kind === 'err') return fp;
    const cc: unknown = u['codeContext'];
    if (!isObject(cc)) return fail(`${at}.codeContext: expected object`);
    if (!Number.isInteger(cc['startLine'])) return fail(`${at}.codeContext.startLine: expected integer`);
    if (!Number.isInteger(cc['endLine'])) return fail(`${at}.codeContext.endLine: expected integer`);
    if (typeof cc['text'] !== 'string') return fail(`${at}.codeContext.text: expected string`);
    units.push({
      exprHash: u['exprHash'],
      factKind: u['factKind'] as FactKind,
      unresolvedExpression: u['unresolvedExpression'],
      enclosingScope: u['enclosingScope'],
      filePath: fp.value as ResolveUnit['filePath'],
      codeContext: {
        startLine: cc['startLine'] as number,
        endLine: cc['endLine'] as number,
        text: cc['text'],
      },
    });
  }

  return ok({
    version: 1, pass: 'llm',
    project: raw['project'],
    generatedAt: raw['generatedAt'] as ResolveBundle['generatedAt'],
    units,
  });
}

export function parseResolutionsFile(raw: unknown): Result<ResolutionsFile, ResolveError> {
  if (!isObject(raw)) return fail('resolutions: expected object');
  if (raw['version'] !== 1) return fail('resolutions.version: expected 1');
  if (raw['pass'] !== 'llm') return fail('resolutions.pass: expected "llm"');
  if (!Array.isArray(raw['resolutions'])) return fail('resolutions.resolutions: expected array');

  const out: Resolution[] = [];
  for (let i = 0; i < raw['resolutions'].length; i++) {
    const e: unknown = raw['resolutions'][i];
    const at = `resolutions[${String(i)}]`;
    if (!isObject(e)) return fail(`${at}: expected object`);
    if (typeof e['exprHash'] !== 'string' || e['exprHash'] === '') {
      return fail(`${at}.exprHash: expected non-empty string`);
    }
    if (typeof e['classification'] !== 'string' || !CLASSES.has(e['classification'])) {
      return fail(`${at}.classification: expected structural-rule | project-constant | data-dependent-unresolvable`);
    }
    const classification = e['classification'] as Classification;
    const hasValue = e['resolvedValue'] !== undefined;
    const hasCite = e['citation'] !== undefined;
    const note = e['note'];
    if (note !== undefined && typeof note !== 'string') {
      return fail(`${at}.note: expected string`);
    }

    if (classification === 'data-dependent-unresolvable') {
      // The cache-marker case: neither field permitted.
      if (hasValue) return fail(`${at}.resolvedValue: must be absent for data-dependent-unresolvable`);
      if (hasCite) return fail(`${at}.citation: must be absent for data-dependent-unresolvable`);
      out.push({ exprHash: e['exprHash'], classification,
        ...(typeof note === 'string' ? { note } : {}) });
      continue;
    }

    // structural-rule / project-constant: the hallucination guard — both
    // resolvedValue.hookName and a verifiable citation are mandatory.
    if (!hasValue) return fail(`${at}.resolvedValue: required for ${classification}`);
    if (!hasCite) return fail(`${at}.citation: required for ${classification}`);
    const rv: unknown = e['resolvedValue'];
    if (!isObject(rv) || typeof rv['hookName'] !== 'string' || rv['hookName'] === '') {
      return fail(`${at}.resolvedValue.hookName: expected non-empty string`);
    }
    const cit: unknown = e['citation'];
    if (!isObject(cit)) return fail(`${at}.citation: expected object`);
    if (!Number.isInteger(cit['line'])) return fail(`${at}.citation.line: expected integer`);
    const cp = relativePath(cit['path'], `${at}.citation.path`);
    if (cp.kind === 'err') return cp;
    out.push({
      exprHash: e['exprHash'],
      classification,
      resolvedValue: { hookName: rv['hookName'] },
      citation: { path: cp.value as ProjectRelativePath, line: cit['line'] as number },
      ...(typeof note === 'string' ? { note } : {}),
    });
  }

  return ok({ version: 1, pass: 'llm', resolutions: out });
}
