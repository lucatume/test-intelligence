import { describe, expect, it } from 'vitest';
import { parseAnchor } from '../../src/anchors/parse.js';
import type { Anchor, RestAnchor } from '../../src/anchors/types.js';

function expectRestAnchor(a: Anchor): RestAnchor {
  expect(a.type).toBe('rest');
  if (a.type !== 'rest') throw new Error('unreachable');
  return a;
}

describe('parseAnchor — rest:', () => {
  it('parses a well-formed rest anchor', () => {
    const r = parseAnchor('rest:GET /myplugin/v1/items');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = expectRestAnchor(r.value);
    expect(v.key).toBe('rest:GET /myplugin/v1/items');
    expect(v.method).toBe('GET');
    expect(v.route).toBe('/myplugin/v1/items');
    expect(v.partial).toBe(false);
  });

  it('normalizes /wp-json/ prefix away', () => {
    const r = parseAnchor('rest:GET /wp-json/myplugin/v1/items');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = expectRestAnchor(r.value);
    expect(v.route).toBe('/myplugin/v1/items');
    expect(v.key).toBe('rest:GET /myplugin/v1/items');
  });

  it('uppercases method', () => {
    const r = parseAnchor('rest:post /foo');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(expectRestAnchor(r.value).method).toBe('POST');
  });

  it('drops trailing slash on route', () => {
    const r = parseAnchor('rest:GET /foo/');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(expectRestAnchor(r.value).route).toBe('/foo');
  });

  it('defaults method to GET when omitted', () => {
    const r = parseAnchor('rest:/myplugin/v1/items');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(expectRestAnchor(r.value).method).toBe('GET');
  });

  it('marks route-param routes as partial', () => {
    const r = parseAnchor('rest:GET /items/{*}');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(expectRestAnchor(r.value).partial).toBe(true);
  });

  it('rejects malformed rest anchors', () => {
    const r = parseAnchor('rest:GET');
    expect(r.kind).toBe('err');
  });
});
