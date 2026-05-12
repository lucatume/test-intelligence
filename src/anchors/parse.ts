import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import type { AnchorKey, AnchorType } from '../types.js';
import { ALL_ANCHOR_TYPES } from '../types.js';
import type { Anchor, AnchorParseError, RestAnchor, SimpleAnchor } from './types.js';

const ROUTE_PARAM_RE = /\{\*\}/;
const WP_JSON_PREFIX = '/wp-json/';
const AJAX_PREFIX = 'wp_ajax_';
const AJAX_NOPRIV_PREFIX = 'wp_ajax_nopriv_';

const ANCHOR_TYPE_SET: ReadonlySet<AnchorType> = new Set(ALL_ANCHOR_TYPES);

export function parseAnchor(raw: string): Result<Anchor, AnchorParseError> {
  const colon = raw.indexOf(':');
  if (colon === -1) return err(makeErr(raw, 'missing ":" separator'));
  const type = raw.slice(0, colon);
  const body = raw.slice(colon + 1);
  if (!ANCHOR_TYPE_SET.has(type as AnchorType)) {
    return err(makeErr(raw, `unknown anchor type "${type}"`));
  }
  if (body === '') return err(makeErr(raw, 'empty body'));
  if (type === 'rest') return parseRest(raw, body);
  if (type === 'ajax') return parseAjax(raw, body);
  if (type === 'php-symbol') return parsePhpSymbol(raw, body);
  return parseSimple(type as Exclude<AnchorType, 'rest'>, body);
}

function parseRest(raw: string, body: string): Result<RestAnchor, AnchorParseError> {
  // body shapes:
  //   "GET /foo"
  //   "/foo"               (implicit GET)
  //   "post /foo"          (case-insensitive method)
  // The first space (if any) separates method from route.
  const trimmed = body.trim();
  if (trimmed === '') return err(makeErr(raw, 'empty body'));
  let method = 'GET';
  let route = trimmed;
  const space = trimmed.indexOf(' ');
  if (space !== -1) {
    method = trimmed.slice(0, space).toUpperCase();
    route = trimmed.slice(space + 1).trim();
  } else if (!trimmed.startsWith('/')) {
    // body is just a method with no route
    return err(makeErr(raw, 'missing route'));
  }
  if (route === '' || !route.startsWith('/')) {
    return err(makeErr(raw, 'route must start with "/"'));
  }
  // `- 1` keeps the leading '/' of the resulting route.
  if (route.startsWith(WP_JSON_PREFIX)) route = route.slice(WP_JSON_PREFIX.length - 1);
  if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
  const partial = ROUTE_PARAM_RE.test(route);
  const key = `rest:${method} ${route}` as AnchorKey;
  return ok({ key, type: 'rest', method, route, partial });
}

function parseAjax(raw: string, body: string): Result<SimpleAnchor, AnchorParseError> {
  let action = body;
  if (action.startsWith(AJAX_NOPRIV_PREFIX)) action = action.slice(AJAX_NOPRIV_PREFIX.length);
  else if (action.startsWith(AJAX_PREFIX)) action = action.slice(AJAX_PREFIX.length);
  if (action === '') return err(makeErr(raw, 'empty ajax action'));
  return ok({ key: `ajax:${action}` as AnchorKey, type: 'ajax', body: action });
}

function parsePhpSymbol(raw: string, body: string): Result<SimpleAnchor, AnchorParseError> {
  const normalized = body.startsWith('\\') ? body.slice(1) : body;
  if (normalized === '') return err(makeErr(raw, 'empty symbol'));
  return ok({ key: `php-symbol:${normalized}` as AnchorKey, type: 'php-symbol', body: normalized });
}

function parseSimple(
  type: Exclude<AnchorType, 'rest'>,
  body: string,
): Result<SimpleAnchor, AnchorParseError> {
  return ok({ key: `${type}:${body}` as AnchorKey, type, body });
}

function makeErr(raw: string, reason: string): AnchorParseError {
  return { kind: 'AnchorParseError', raw, reason };
}
