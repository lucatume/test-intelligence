import { parseAnchor } from '../anchors/parse.js';
import { err, ok } from '../result.js';
import * as P from '../parse.js';
import type { ParseResult, ValidationError, Schema } from '../parse.js';
import type { FactKind } from '../types.js';
import type {
  AnchorRole,
  Fact,
  FactAnchorRef,
  FactLocation,
  FactPayload,
} from './types.js';

const ALL_FACT_KINDS: readonly FactKind[] = [
  'symbol-def', 'symbol-use', 'import-edge', 'php-include',
  'hook-listener', 'hook-fire', 'rest-endpoint', 'rest-call-js',
  'ajax-listener', 'ajax-call-js', 'enqueue-script',
  'admin-page-nav', 'admin-page-register', 'store-register', 'store-access', 'script-localize',
  'script-localize-inline', 'shortcode', 'block-render', 'test-def',
  'parse-error',
] as const;
const FACT_KIND_SET: ReadonlySet<string> = new Set(ALL_FACT_KINDS);

const ALL_ANCHOR_ROLES: readonly AnchorRole[] = ['subject', 'target', 'callback', 'module'];
const ANCHOR_ROLE_SET: ReadonlySet<string> = new Set(ALL_ANCHOR_ROLES);

const factLocationSchema = P.object(
  {
    file: P.string,
    startLine: P.refine(P.number, (n) => (Number.isInteger(n) && n >= 0 ? null : 'must be a non-negative integer')),
    endLine: P.refine(P.number, (n) => (Number.isInteger(n) && n >= 0 ? null : 'must be a non-negative integer')),
  },
  { strict: true },
);

const factAnchorRefSchema = P.object(
  {
    key: P.string,
    role: P.string,
  },
  { strict: true },
);

const symbolDefPayload = P.object(
  { kind: P.literal('symbol-def'), name: P.string, exported: P.boolean, meta: P.optional(P.record(P.unknown)) },
  { strict: true },
);
const symbolUsePayload = P.object(
  { kind: P.literal('symbol-use'), name: P.string, meta: P.optional(P.record(P.unknown)) },
  { strict: true },
);
const importEdgePayload = P.object(
  { kind: P.literal('import-edge'), specifier: P.string, resolved: P.boolean, resolvedPath: P.optional(P.string), meta: P.optional(P.record(P.unknown)) },
  { strict: true },
);
const testDefPayload = P.object(
  { kind: P.literal('test-def'), framework: P.enumOf(['phpunit', 'jest', 'playwright'] as const), testId: P.string, title: P.optional(P.string), meta: P.optional(P.record(P.unknown)) },
  { strict: true },
);
const parseErrorPayload = P.object(
  { kind: P.literal('parse-error'), message: P.string, line: P.optional(P.number) },
  { strict: true },
);

function passthroughPayload(kindLit: string): Schema<FactPayload> {
  return {
    parse(input): ParseResult<FactPayload> {
      if (!isPlainObject(input)) return err([{ path: [], message: 'expected object' }]);
      const k = input.kind;
      if (k !== kindLit) return err([{ path: ['kind'], message: `expected "${kindLit}"` }]);
      return ok(input as unknown as FactPayload);
    },
  };
}

const PAYLOAD_BY_KIND: Record<FactKind, Schema<FactPayload>> = {
  'symbol-def': symbolDefPayload as unknown as Schema<FactPayload>,
  'symbol-use': symbolUsePayload as unknown as Schema<FactPayload>,
  'import-edge': importEdgePayload as unknown as Schema<FactPayload>,
  'test-def': testDefPayload as unknown as Schema<FactPayload>,
  'parse-error': parseErrorPayload as unknown as Schema<FactPayload>,
  'php-include': passthroughPayload('php-include'),
  'hook-listener': passthroughPayload('hook-listener'),
  'hook-fire': passthroughPayload('hook-fire'),
  'rest-endpoint': passthroughPayload('rest-endpoint'),
  'rest-call-js': passthroughPayload('rest-call-js'),
  'ajax-listener': passthroughPayload('ajax-listener'),
  'ajax-call-js': passthroughPayload('ajax-call-js'),
  'enqueue-script': passthroughPayload('enqueue-script'),
  'admin-page-nav': passthroughPayload('admin-page-nav'),
  'admin-page-register': passthroughPayload('admin-page-register'),
  'store-register': passthroughPayload('store-register'),
  'store-access': passthroughPayload('store-access'),
  'script-localize': passthroughPayload('script-localize'),
  'script-localize-inline': passthroughPayload('script-localize-inline'),
  shortcode: passthroughPayload('shortcode'),
  'block-render': passthroughPayload('block-render'),
};

export function parseFact(raw: unknown): ParseResult<Fact> {
  if (!isPlainObject(raw)) return err([{ path: [], message: 'expected object' }]);
  const r = raw;

  if (typeof r.kind !== 'string' || !FACT_KIND_SET.has(r.kind)) {
    return err([{ path: ['kind'], message: 'unknown fact kind' }]);
  }
  const kind = r.kind as FactKind;
  if (typeof r.resolved !== 'boolean') {
    return err([{ path: ['resolved'], message: 'expected boolean' }]);
  }

  const locRes = factLocationSchema.parse(r.location);
  if (locRes.kind === 'err') return prefix('location', locRes.error);
  const location = locRes.value as FactLocation;

  if (!Array.isArray(r.anchors)) {
    return err([{ path: ['anchors'], message: 'expected array' }]);
  }
  const anchors: FactAnchorRef[] = [];
  for (let i = 0; i < r.anchors.length; i++) {
    const a = factAnchorRefSchema.parse(r.anchors[i]);
    if (a.kind === 'err') return prefix(`anchors[${String(i)}]`, a.error);
    if (!ANCHOR_ROLE_SET.has(a.value.role)) {
      return err([{ path: ['anchors', String(i), 'role'], message: 'unknown anchor role' }]);
    }
    const anchorParse = parseAnchor(a.value.key);
    if (anchorParse.kind === 'err') {
      return err([{ path: ['anchors', String(i), 'key'], message: anchorParse.error.reason }]);
    }
    anchors.push({ key: anchorParse.value.key, role: a.value.role as AnchorRole });
  }

  const payloadSchema = PAYLOAD_BY_KIND[kind];
  const payloadRes = payloadSchema.parse(r.payload);
  if (payloadRes.kind === 'err') return prefix('payload', payloadRes.error);
  const payload = payloadRes.value;
  if ((payload as { kind: string }).kind !== kind) {
    return err([{ path: ['payload', 'kind'], message: `expected "${kind}"` }]);
  }

  return ok({ kind, resolved: r.resolved, location, anchors, payload });
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function prefix(p: string, errs: readonly ValidationError[]): ParseResult<never> {
  return err(errs.map((e) => ({ path: [p, ...e.path], message: e.message })));
}
