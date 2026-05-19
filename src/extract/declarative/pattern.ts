import * as P from '../../parse.js';
import type { ParseResult } from '../../parse.js';
import type { FactKind } from '../../types.js';

export type PatternLang = 'php' | 'js' | 'ts';
export type NodeKind = 'function-call' | 'method-call' | 'static-call' | 'new-expression' | 'jsx-element';
export type BindType = 'string' | 'int' | 'bool' | 'callable' | 'object' | 'array' | 'path-literal' | 'regex-literal';

export interface Binding {
  readonly arg: number;
  readonly type: BindType;
  readonly default?: unknown;
  readonly optional?: boolean;
}

export type AnchorRoleLit = 'subject' | 'target' | 'callback' | 'module';

export interface PatternAnchor {
  readonly template: string;
  readonly role: AnchorRoleLit;
}

export interface UserPattern {
  readonly match: {
    readonly lang: PatternLang;
    readonly nodeKind: NodeKind;
    readonly name: string;
    readonly receiver?: string;
  };
  readonly bind: Readonly<Record<string, Binding>>;
  readonly emit: FactKind;
  readonly anchor?: PatternAnchor;
  readonly transform?:
    | 'rest-route'
    | 'enqueue-src'
    | 'ajax-action-from-url'
    | 'admin-page-slug-from-url'
    | 'admin-page-slug'
    | 'block-render'
    | 'localize-data';
}

const ALL_FACT_KINDS: readonly FactKind[] = [
  'symbol-def', 'symbol-use', 'import-edge', 'php-include',
  'hook-listener', 'hook-fire', 'rest-endpoint', 'rest-call-js',
  'ajax-listener', 'ajax-call-js', 'enqueue-script', 'store-register', 'store-access', 'script-localize',
  'script-localize-inline', 'shortcode', 'block-render', 'test-def', 'parse-error',
];

const bindingSchema = P.object(
  {
    arg: P.refine(P.number, (n) => (Number.isInteger(n) && n >= 0 ? null : 'must be a non-negative integer')),
    type: P.enumOf(['string', 'int', 'bool', 'callable', 'object', 'array', 'path-literal', 'regex-literal'] as const),
    default: P.optional(P.unknown),
    optional: P.optional(P.boolean),
  },
  { strict: true },
);

const matchSchema = P.object(
  {
    lang: P.enumOf(['php', 'js', 'ts'] as const),
    nodeKind: P.enumOf(['function-call', 'method-call', 'static-call', 'new-expression', 'jsx-element'] as const),
    name: P.string,
    receiver: P.optional(P.string),
  },
  { strict: true },
);

const anchorSchema = P.object(
  {
    template: P.string,
    role: P.enumOf(['subject', 'target', 'callback', 'module'] as const),
  },
  { strict: true },
);

const patternSchema = P.object(
  {
    match: matchSchema,
    bind: P.record(bindingSchema),
    emit: P.refine(P.string, (s) => (ALL_FACT_KINDS.includes(s as FactKind) ? null : `unknown FactKind "${s}"`)),
    anchor: P.optional(anchorSchema),
    transform: P.optional(
      P.enumOf([
        'rest-route',
        'enqueue-src',
        'ajax-action-from-url',
        'admin-page-slug-from-url',
        'admin-page-slug',
        'block-render',
      ] as const),
    ),
  },
  { strict: true },
);

export function parsePattern(raw: unknown): ParseResult<UserPattern> {
  return patternSchema.parse(raw) as ParseResult<UserPattern>;
}
