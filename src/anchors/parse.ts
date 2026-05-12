import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import type { AnchorKey } from '../types.js';
import type { Anchor, AnchorParseError, RestAnchor } from './types.js';

const ROUTE_PARAM_RE = /\{\*\}/;
const WP_JSON_PREFIX = '/wp-json/';

export function parseAnchor(raw: string): Result<Anchor, AnchorParseError> {
  const colon = raw.indexOf(':');
  if (colon === -1) return err(makeErr(raw, 'missing ":" separator'));
  const type = raw.slice(0, colon);
  const body = raw.slice(colon + 1);
  if (type === 'rest') return parseRest(raw, body);
  return err(makeErr(raw, `anchor type "${type}" not yet supported`));
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

function makeErr(raw: string, reason: string): AnchorParseError {
  return { kind: 'AnchorParseError', raw, reason };
}
