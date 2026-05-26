// Branded primitives: each has exactly one constructor (its parser).
// Interior code handles only these branded values — never raw strings or numbers
// for things that carry semantic meaning.
//
// The `__brand` field is the outer brand; `__kind` is the inner discriminator
// when a brand has sub-variants (e.g., SourcePath vs TestFilePath both extend
// ProjectRelativePath). This two-level scheme is intentional — the outer brand
// enforces "this string has been through path-parser rules," the inner kind
// enforces "this path is a source (or test) path specifically." Do not collapse.

export type ProjectRelativePath = string & { readonly __brand: 'ProjectRelativePath' };
export type SourcePath          = ProjectRelativePath & { readonly __kind: 'Source' };
export type TestFilePath        = ProjectRelativePath & { readonly __kind: 'Test' };

export type Confidence = number & { readonly __brand: 'Confidence' }; // 0..1

export type FrameworkName = 'phpunit' | 'jest' | 'playwright';

export type ISODate = string & { readonly __brand: 'ISODate' };

export type RunnerInvocation = {
  readonly bin: string;
  readonly args: readonly string[];
};

// Sealed v1 fact kinds. Adding entries here requires updating built-in
// extractors, derivation rules, and the storage schema.
export type FactKind =
  | 'symbol-def'
  | 'symbol-use'
  | 'import-edge'
  | 'php-include'
  | 'hook-listener'
  | 'hook-fire'
  | 'rest-endpoint'
  | 'rest-call-js'
  | 'ajax-listener'
  | 'ajax-call-js'
  | 'enqueue-script'
  | 'admin-page-nav'
  | 'admin-page-register'
  | 'store-register'
  | 'store-access'
  | 'script-localize'
  | 'script-localize-inline'
  | 'shortcode'
  | 'block-render'
  | 'test-def'
  | 'parse-error';

// Normalized anchor key (e.g. 'rest:GET /myplugin/v1/items'). The single
// constructor is `parseAnchor` in src/anchors/parse.ts.
export type AnchorKey = string & { readonly __brand: 'AnchorKey' };

// Anchor "type" — the prefix before the colon in the AnchorKey grammar.
export type AnchorType =
  | 'php-symbol'
  | 'js-symbol'
  | 'js-module'
  | 'php-file'
  | 'hook'
  | 'rest'
  | 'ajax'
  | 'script-handle'
  | 'wp-admin-page'
  | 'wp-frontend'
  | 'wp-store'
  | 'shortcode'
  | 'block'
  | 'test';

// Languages we classify in discover and dispatch to extractors. Living in the
// foundation zone so both `discover/` and `extract/` can use it without
// `extract` having to depend on `discover` (which would cross zone boundaries).
export type Language = 'php' | 'ts' | 'tsx' | 'js' | 'jsx' | 'mjs' | 'cjs';

export const ALL_LANGUAGES: readonly Language[] = ['php', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

export const ALL_ANCHOR_TYPES = [
  'php-symbol',
  'js-symbol',
  'js-module',
  'php-file',
  'hook',
  'rest',
  'ajax',
  'script-handle',
  'wp-admin-page',
  'wp-frontend',
  'wp-store',
  'shortcode',
  'block',
  'test',
] as const satisfies readonly AnchorType[];

// Valid function names that may appear as the `wraps` field of a WpPatternWrapper.
// Kept in foundation so both config/ and extract/ can reference it without a
// cross-zone import violation.
export const WP_PHP_PATTERN_NAMES: ReadonlySet<string> = new Set([
  'add_action',
  'add_filter',
  'do_action',
  'apply_filters',
  'register_rest_route',
  'wp_enqueue_script',
  'wp_register_script',
  'wp_enqueue_style',
  'wp_register_style',
  'wp_localize_script',
  'add_shortcode',
  'do_shortcode',
  'register_block_type',
  'register_block_type_from_metadata',
  'add_menu_page',
  'add_submenu_page',
]);

export type ArgSpec =
  | { readonly kind: 'fixed'; readonly value: string | number | boolean | ReadonlyArray<unknown> | Readonly<Record<string, unknown>> }
  | { readonly kind: 'param'; readonly wrapperParamIdx: number }
  | { readonly kind: 'merge'; readonly defaults: Readonly<Record<string, unknown>>; readonly callerParamIdx: number }
  | { readonly kind: 'unresolved' };

export interface WpPatternWrapper {
  readonly name: string;
  readonly wraps: string;
  readonly argSpecs: ReadonlyArray<ArgSpec>;
}
