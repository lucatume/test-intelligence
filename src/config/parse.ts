import * as P from '../parse.js';
import type { ParseResult, ValidationError } from '../parse.js';
import { ok, err } from '../result.js';
import type { ArgSpec, WpPatternWrapper } from '../types.js';
import { WP_PHP_PATTERN_NAMES } from '../types.js';

export type FrameworkClass = 'unit' | 'e2e';

export interface TestClassRule {
  readonly paths?: readonly string[];
  readonly phpunitBaseClasses?: readonly string[];
  readonly class: FrameworkClass;
}

export interface PhpUnitConfig {
  readonly baseClasses: readonly string[];
  readonly methodPatterns: readonly string[];
}

export interface JestConfig {
  readonly fileGlobs: readonly string[];
}

export interface PlaywrightConfig {
  readonly fileGlobs?: readonly string[];
}

export interface TestsConfig {
  readonly phpunit: PhpUnitConfig;
  readonly jest: JestConfig;
  readonly playwright: PlaywrightConfig;
  readonly classes: readonly TestClassRule[];
  readonly defaultClass: FrameworkClass;
}

export interface HookStopList {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

export interface HooksConfig {
  readonly stopList: HookStopList;
}

export interface ConfidenceConfig {
  readonly weights: Readonly<Record<string, number>>;
  readonly threshold: number;
}

export interface TraversalConfig {
  readonly maxDepth: number;
  readonly maxMillisPerTest: number;
  readonly maxWildcardMatchesPerAnchor: number;
}

export interface ConcurrencyConfig {
  readonly phpWorkers?: number;
  readonly tsWorkers?: number;
  readonly deriveWorkers?: number;
}

export interface BuildConfig {
  /** Directory names treated as compiled build output. The compiled→source
   *  join only attempts *.asset.php / build→src remapping for js-module paths
   *  under one of these directories. */
  readonly outputDirs: readonly string[];
}

// Per-bundle toggles for the built-in ignore defaults. Each defaults to true
// — disabling a bundle removes its globs from the effective ignore list.
// The baseline (node_modules, .git, dist, build) is unconditional and cannot
// be disabled here; a user who really wants to scan node_modules can add a
// custom `ignore` entry layout, but the safe default is non-negotiable.
export interface IgnoreDefaultsConfig {
  readonly agenticWorktrees: boolean;
  readonly toolDirs: boolean;
  readonly testArtifacts: boolean;
  readonly buildCaches: boolean;
  readonly minified: boolean;
}

// Extractor entries are kept as opaque values in Plan A; Plan C tightens the schema.
export type ExtractorEntry = unknown;

export interface ValidatedConfig {
  readonly tests: TestsConfig;
  readonly hooks: HooksConfig;
  readonly extractors: readonly ExtractorEntry[];
  readonly confidence: ConfidenceConfig;
  readonly traversal: TraversalConfig;
  readonly concurrency: ConcurrencyConfig;
  readonly build: BuildConfig;
  readonly ignore: readonly string[];
  readonly ignoreDefaults: IgnoreDefaultsConfig;
  readonly vendor: readonly string[];
  readonly allowSymlinkTargets: readonly string[];
  readonly wpPatternWrappers: readonly WpPatternWrapper[];
}

// UserConfig is the recursively-relaxed shape that users write — defaults fill in ValidatedConfig.
// At this stage, it is the same `unknown`-ish input shape accepted by parseConfig; once Plan B
// surfaces a stricter authoring type, this alias gets tightened.
export type UserConfig = Partial<{
  tests: unknown;
  hooks: unknown;
  extractors: readonly unknown[];
  confidence: unknown;
  traversal: unknown;
  concurrency: unknown;
  build: unknown;
  ignore: readonly string[];
  ignoreDefaults: Partial<IgnoreDefaultsConfig>;
  vendor: readonly string[];
  allowSymlinkTargets: readonly string[];
  wpPatternWrappers: readonly WpPatternWrapper[];
}>;

const DEFAULT_PHPUNIT_BASE_CLASSES: readonly string[] = ['PHPUnit\\Framework\\TestCase'];
const DEFAULT_PHPUNIT_METHOD_PATTERNS: readonly string[] = ['test*', '@test', '#[Test]'];
const DEFAULT_JEST_FILE_GLOBS: readonly string[] = [
  '**/*.test.{ts,tsx,js,jsx}',
  '**/*.spec.{ts,tsx,js,jsx}',
];
// Patterns are doubled (`**/X` + `**/X/**`) so the walker prunes the directory
// entry itself (no recursion) and also filters any descendant that slips through.
// Monorepos (pnpm/Yarn workspaces) put dependency / build dirs under every
// package, so anchoring at the project root is not enough.
function dirGlobs(name: string): readonly string[] {
  return [`**/${name}`, `**/${name}/**`];
}

// Unconditional defaults — present regardless of ignoreDefaults toggles.
const IGNORE_BASELINE: readonly string[] = [
  ...dirGlobs('node_modules'),
  ...dirGlobs('dist'),
  ...dirGlobs('build'),
  ...dirGlobs('.git'),
];

// Bundle: agentic worktrees. Claude Code defaults to `.claude/worktrees`;
// obra/superpowers uses `.worktrees`; Codex / generic guides recommend a
// sibling `worktrees/` dir. All three live inside the repo and confuse
// extraction because they contain a complete duplicate of the codebase.
const IGNORE_AGENTIC_WORKTREES: readonly string[] = [
  '**/.claude/worktrees',
  '**/.claude/worktrees/**',
  ...dirGlobs('.worktrees'),
  ...dirGlobs('worktrees'),
];

// Bundle: vendored tool dirs (JS toolchain).
// .yarn/{cache,releases,unplugged,sdks} — Yarn Berry zero-installs + binary.
// .pnp.* — Yarn PnP loader files (cjs/mjs/data.json).
// .bun, .pnpm-store — bun cache, pnpm content-addressable store.
const IGNORE_TOOL_DIRS: readonly string[] = [
  ...dirGlobs('.yarn/cache'),
  ...dirGlobs('.yarn/releases'),
  ...dirGlobs('.yarn/unplugged'),
  ...dirGlobs('.yarn/sdks'),
  '**/.yarn/install-state.gz',
  '**/.yarn/build-state.yml',
  '**/.pnp.*',
  ...dirGlobs('.bun'),
  ...dirGlobs('.pnpm-store'),
];

// Bundle: test artifacts emitted by playwright / cypress / coverage tools.
const IGNORE_TEST_ARTIFACTS: readonly string[] = [
  ...dirGlobs('playwright-report'),
  ...dirGlobs('test-results'),
  ...dirGlobs('blob-report'),
  ...dirGlobs('playwright/.cache'),
  ...dirGlobs('cypress/videos'),
  ...dirGlobs('cypress/screenshots'),
  ...dirGlobs('cypress/downloads'),
  ...dirGlobs('coverage'),
  ...dirGlobs('.nyc_output'),
];

// Bundle: framework build/cache dirs that hold generated code or assets.
const IGNORE_BUILD_CACHES: readonly string[] = [
  ...dirGlobs('.next'),
  ...dirGlobs('.nuxt'),
  ...dirGlobs('.svelte-kit'),
  ...dirGlobs('.turbo'),
  ...dirGlobs('.parcel-cache'),
  ...dirGlobs('.vercel'),
  ...dirGlobs('.netlify'),
  ...dirGlobs('.cache'),
  ...dirGlobs('.angular'),
];

// Bundle: minified bundles. Parsing them is slow and they rarely contribute
// useful test↔source edges. Disable via ignoreDefaults.minified=false if you
// genuinely need them indexed.
const IGNORE_MINIFIED: readonly string[] = [
  '**/*.min.js',
  '**/*.min.mjs',
  '**/*.min.cjs',
  '**/*.min.jsx',
  '**/*.min.ts',
  '**/*.min.tsx',
  '**/*.min.css',
];

const DEFAULT_IGNORE_TOGGLES: IgnoreDefaultsConfig = {
  agenticWorktrees: true,
  toolDirs: true,
  testArtifacts: true,
  buildCaches: true,
  minified: true,
};

const DEFAULT_VENDOR: readonly string[] = ['**/vendor', '**/vendor/**'];
const DEFAULT_MAX_DEPTH = 100;
const DEFAULT_MAX_MILLIS_PER_TEST = 5000;
const DEFAULT_MAX_WILDCARD_MATCHES_PER_ANCHOR = 32;

// HOOK_STOP_LIST_BUILTINS is the default set of WP hooks that fire on every
// page load and should not be walked by the derivation engine. The effective
// stop-list at derivation time is `(BUILTINS ∪ hooks.stopList.add) \ hooks.stopList.remove`.
// This export is consumed by the derivation engine landing in Plan D.
export const HOOK_STOP_LIST_BUILTINS: readonly string[] = [
  'init',
  'wp_loaded',
  'plugins_loaded',
  'admin_init',
  'wp_head',
  'wp_footer',
  'template_redirect',
  'parse_request',
  'wp_enqueue_scripts',
  'admin_enqueue_scripts',
];

// Opaque schema for extractor entries. Plan C will tighten this to a discriminated union.
const anyValue: P.Schema<unknown> = {
  parse(input) {
    return ok(input);
  },
};

const testClassRuleSchema = P.object(
  {
    paths: P.optional(P.array(P.string)),
    phpunitBaseClasses: P.optional(P.array(P.string)),
    class: P.enumOf(['unit', 'e2e'] as const),
  },
  { strict: true },
);

const testsSchema = P.object(
  {
    phpunit: P.optional(P.object(
      {
        baseClasses: P.optional(P.array(P.string)),
        methodPatterns: P.optional(P.array(P.string)),
      },
      { strict: true },
    )),
    jest: P.optional(P.object(
      {
        fileGlobs: P.optional(P.array(P.string)),
      },
      { strict: true },
    )),
    playwright: P.optional(P.object(
      {
        fileGlobs: P.optional(P.array(P.string)),
      },
      { strict: true },
    )),
    classes: P.optional(P.array(testClassRuleSchema)),
    defaultClass: P.optional(P.enumOf(['unit', 'e2e'] as const)),
  },
  { strict: true },
);

const hooksSchema = P.object(
  {
    stopList: P.optional(P.object(
      {
        add: P.optional(P.array(P.string)),
        remove: P.optional(P.array(P.string)),
      },
      { strict: true },
    )),
  },
  { strict: true },
);

const confidenceSchema = P.object(
  {
    weights: P.optional(P.record(P.number)),
    threshold: P.optional(
      P.refine(P.number, (n) => (n >= 0 && n <= 1 ? null : 'must be in [0, 1]')),
    ),
  },
  { strict: true },
);

const traversalSchema = P.object(
  {
    maxDepth: P.optional(
      P.refine(P.number, (n) => (n >= 0 ? null : 'must be >= 0')),
    ),
    maxMillisPerTest: P.optional(
      P.refine(P.number, (n) => (n >= 0 ? null : 'must be >= 0')),
    ),
    maxWildcardMatchesPerAnchor: P.optional(
      P.refine(P.number, (n) => (n >= 1 ? null : 'must be >= 1')),
    ),
  },
  { strict: true },
);

const concurrencySchema = P.object(
  {
    phpWorkers: P.optional(P.refine(P.number, (n) => (n >= 0 ? null : 'must be >= 0'))),
    tsWorkers: P.optional(P.refine(P.number, (n) => (n >= 0 ? null : 'must be >= 0'))),
    deriveWorkers: P.optional(P.refine(P.number, (n) => (n >= 0 ? null : 'must be >= 0'))),
  },
  { strict: true },
);

const DEFAULT_BUILD_OUTPUT_DIRS: readonly string[] = ['build', 'dist'];

const buildSchema = P.object(
  {
    outputDirs: P.optional(P.array(P.string)),
  },
  { strict: true },
);

const ignoreDefaultsSchema = P.object(
  {
    agenticWorktrees: P.optional(P.boolean),
    toolDirs: P.optional(P.boolean),
    testArtifacts: P.optional(P.boolean),
    buildCaches: P.optional(P.boolean),
    minified: P.optional(P.boolean),
  },
  { strict: true },
);

// ArgSpec discriminated-union schema. Each variant switches on `kind`.
const argSpecSchema: P.Schema<ArgSpec> = {
  parse(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return err([{ path: [], message: `expected object, got ${input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input}` }]);
    }
    const obj = input as Record<string, unknown>;
    const kind = obj['kind'];
    switch (kind) {
      case 'fixed': {
        if (!Object.prototype.hasOwnProperty.call(obj, 'value')) {
          return err([{ path: ['value'], message: 'missing required field' }]);
        }
        return ok({ kind: 'fixed' as const, value: obj['value'] as ArgSpec & { kind: 'fixed' } extends { value: infer V } ? V : never });
      }
      case 'param': {
        const idx = obj['wrapperParamIdx'];
        if (typeof idx !== 'number') {
          return err([{ path: ['wrapperParamIdx'], message: 'expected number' }]);
        }
        return ok({ kind: 'param' as const, wrapperParamIdx: idx });
      }
      case 'merge': {
        const defaults = obj['defaults'];
        if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
          return err([{ path: ['defaults'], message: 'expected object' }]);
        }
        const callerIdx = obj['callerParamIdx'];
        if (typeof callerIdx !== 'number') {
          return err([{ path: ['callerParamIdx'], message: 'expected number' }]);
        }
        return ok({ kind: 'merge' as const, defaults: defaults as Readonly<Record<string, unknown>>, callerParamIdx: callerIdx });
      }
      case 'unresolved': {
        return ok({ kind: 'unresolved' as const });
      }
      default: {
        const render = typeof kind === 'string' ? `"${kind}"` : String(kind);
        return err([{ path: ['kind'], message: `expected one of [fixed, param, merge, unresolved], got ${render}` }]);
      }
    }
  },
};

const wpPatternWrapperSchema: P.Schema<WpPatternWrapper> = {
  parse(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return err([{ path: [], message: `expected object, got ${input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input}` }]);
    }
    const obj = input as Record<string, unknown>;
    const errors: ValidationError[] = [];

    const name = obj['name'];
    if (typeof name !== 'string') {
      errors.push({ path: ['name'], message: 'expected string' });
    }
    const wraps = obj['wraps'];
    if (typeof wraps !== 'string') {
      errors.push({ path: ['wraps'], message: 'expected string' });
    } else if (!WP_PHP_PATTERN_NAMES.has(wraps)) {
      errors.push({ path: ['wraps'], message: `"${wraps}" is not a known WP PHP pattern name` });
    }
    const rawArgSpecs = obj['argSpecs'];
    if (!Array.isArray(rawArgSpecs)) {
      errors.push({ path: ['argSpecs'], message: 'expected array' });
    }
    if (errors.length) return err(errors);

    const argSpecs: ArgSpec[] = [];
    const specsArray = rawArgSpecs as unknown[];
    for (let i = 0; i < specsArray.length; i++) {
      const r = argSpecSchema.parse(specsArray[i]);
      if (r.kind === 'err') {
        errors.push(...r.error.map((e) => ({ path: ['argSpecs', i, ...e.path] as (string | number)[], message: e.message })));
      } else {
        argSpecs.push(r.value);
      }
    }
    if (errors.length) return err(errors);

    return ok({
      name: name as string,
      wraps: wraps as string,
      argSpecs,
    });
  },
};

const rootSchema = P.object(
  {
    tests: P.optional(testsSchema),
    hooks: P.optional(hooksSchema),
    extractors: P.optional(P.array(anyValue)),
    confidence: P.optional(confidenceSchema),
    traversal: P.optional(traversalSchema),
    concurrency: P.optional(concurrencySchema),
    build: P.optional(buildSchema),
    ignore: P.optional(P.array(P.string)),
    ignoreDefaults: P.optional(ignoreDefaultsSchema),
    vendor: P.optional(P.array(P.string)),
    allowSymlinkTargets: P.optional(P.array(P.string)),
    wpPatternWrappers: P.optional(P.array(wpPatternWrapperSchema)),
  },
  { strict: true },
);

export function parseConfig(raw: unknown): ParseResult<ValidatedConfig> {
  const parsed = rootSchema.parse(raw);
  if (parsed.kind === 'err') return parsed;
  const r = parsed.value;

  // Build optional-typed sub-objects defensively: under exactOptionalPropertyTypes,
  // a `key: undefined` literal is not assignable to an optional property.
  const playwright: PlaywrightConfig = r.tests?.playwright?.fileGlobs !== undefined
    ? { fileGlobs: r.tests.playwright.fileGlobs }
    : {};

  const classes: readonly TestClassRule[] = (r.tests?.classes ?? []).map((c) => {
    const rule: TestClassRule = { class: c.class };
    return c.paths !== undefined
      ? c.phpunitBaseClasses !== undefined
        ? { ...rule, paths: c.paths, phpunitBaseClasses: c.phpunitBaseClasses }
        : { ...rule, paths: c.paths }
      : c.phpunitBaseClasses !== undefined
        ? { ...rule, phpunitBaseClasses: c.phpunitBaseClasses }
        : rule;
  });

  const concurrency: ConcurrencyConfig = {};
  const concIn = r.concurrency;
  const mutableConc = concurrency as {
    phpWorkers?: number;
    tsWorkers?: number;
    deriveWorkers?: number;
  };
  if (concIn?.phpWorkers !== undefined) mutableConc.phpWorkers = concIn.phpWorkers;
  if (concIn?.tsWorkers !== undefined) mutableConc.tsWorkers = concIn.tsWorkers;
  if (concIn?.deriveWorkers !== undefined) mutableConc.deriveWorkers = concIn.deriveWorkers;

  const value: ValidatedConfig = {
    tests: {
      phpunit: {
        baseClasses: r.tests?.phpunit?.baseClasses ?? DEFAULT_PHPUNIT_BASE_CLASSES,
        methodPatterns: r.tests?.phpunit?.methodPatterns ?? DEFAULT_PHPUNIT_METHOD_PATTERNS,
      },
      jest: {
        fileGlobs: r.tests?.jest?.fileGlobs ?? DEFAULT_JEST_FILE_GLOBS,
      },
      playwright,
      classes,
      defaultClass: r.tests?.defaultClass ?? 'unit',
    },
    hooks: {
      stopList: {
        add: r.hooks?.stopList?.add ?? [],
        remove: r.hooks?.stopList?.remove ?? [],
      },
    },
    extractors: r.extractors ?? [],
    confidence: {
      weights: r.confidence?.weights ?? {},
      threshold: r.confidence?.threshold ?? 0.0,
    },
    traversal: {
      maxDepth: r.traversal?.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxMillisPerTest: r.traversal?.maxMillisPerTest ?? DEFAULT_MAX_MILLIS_PER_TEST,
      maxWildcardMatchesPerAnchor: r.traversal?.maxWildcardMatchesPerAnchor ?? DEFAULT_MAX_WILDCARD_MATCHES_PER_ANCHOR,
    },
    concurrency,
    build: {
      outputDirs: r.build?.outputDirs ?? DEFAULT_BUILD_OUTPUT_DIRS,
    },
    ignore: computeEffectiveIgnore(r.ignore, r.ignoreDefaults),
    ignoreDefaults: resolveIgnoreDefaults(r.ignoreDefaults),
    vendor: r.vendor ?? DEFAULT_VENDOR,
    allowSymlinkTargets: r.allowSymlinkTargets ?? [],
    wpPatternWrappers: r.wpPatternWrappers ?? [],
  };
  return ok(value);
}

interface RawToggles {
  readonly agenticWorktrees?: boolean | undefined;
  readonly toolDirs?: boolean | undefined;
  readonly testArtifacts?: boolean | undefined;
  readonly buildCaches?: boolean | undefined;
  readonly minified?: boolean | undefined;
}

function resolveIgnoreDefaults(raw: RawToggles | undefined): IgnoreDefaultsConfig {
  return {
    agenticWorktrees: raw?.agenticWorktrees ?? DEFAULT_IGNORE_TOGGLES.agenticWorktrees,
    toolDirs: raw?.toolDirs ?? DEFAULT_IGNORE_TOGGLES.toolDirs,
    testArtifacts: raw?.testArtifacts ?? DEFAULT_IGNORE_TOGGLES.testArtifacts,
    buildCaches: raw?.buildCaches ?? DEFAULT_IGNORE_TOGGLES.buildCaches,
    minified: raw?.minified ?? DEFAULT_IGNORE_TOGGLES.minified,
  };
}

function computeEffectiveIgnore(
  userAdditions: readonly string[] | undefined,
  rawToggles: RawToggles | undefined,
): readonly string[] {
  const toggles = resolveIgnoreDefaults(rawToggles);
  const out: string[] = [...IGNORE_BASELINE];
  if (toggles.agenticWorktrees) out.push(...IGNORE_AGENTIC_WORKTREES);
  if (toggles.toolDirs) out.push(...IGNORE_TOOL_DIRS);
  if (toggles.testArtifacts) out.push(...IGNORE_TEST_ARTIFACTS);
  if (toggles.buildCaches) out.push(...IGNORE_BUILD_CACHES);
  if (toggles.minified) out.push(...IGNORE_MINIFIED);
  if (userAdditions !== undefined) out.push(...userAdditions);
  return out;
}
