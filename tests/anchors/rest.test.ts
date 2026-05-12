import { describe, expect, it } from 'vitest';
import { parseAnchor } from '../../src/anchors/parse.js';

describe('parseAnchor — rest:', () => {
  it('parses a well-formed rest anchor', () => {
    const r = parseAnchor('rest:GET /myplugin/v1/items');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.type === 'rest') {
      expect(r.value.type).toBe('rest');
      expect(r.value.key).toBe('rest:GET /myplugin/v1/items');
      expect(r.value.method).toBe('GET');
      expect(r.value.route).toBe('/myplugin/v1/items');
      expect(r.value.partial).toBe(false);
    }
  });

  it('normalizes /wp-json/ prefix away', () => {
    const r = parseAnchor('rest:GET /wp-json/myplugin/v1/items');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.type === 'rest') {
      expect(r.value.route).toBe('/myplugin/v1/items');
      expect(r.value.key).toBe('rest:GET /myplugin/v1/items');
    }
  });

  it('uppercases method', () => {
    const r = parseAnchor('rest:post /foo');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.type === 'rest') expect(r.value.method).toBe('POST');
  });

  it('drops trailing slash on route', () => {
    const r = parseAnchor('rest:GET /foo/');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.type === 'rest') expect(r.value.route).toBe('/foo');
  });

  it('defaults method to GET when omitted', () => {
    const r = parseAnchor('rest:/myplugin/v1/items');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.type === 'rest') expect(r.value.method).toBe('GET');
  });

  it('marks route-param routes as partial', () => {
    const r = parseAnchor('rest:GET /items/{*}');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.value.type === 'rest') expect(r.value.partial).toBe(true);
  });

  it('rejects malformed rest anchors', () => {
    const r = parseAnchor('rest:GET');
    expect(r.kind).toBe('err');
  });
});
