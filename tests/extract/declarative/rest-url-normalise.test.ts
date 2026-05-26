import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../../src/extract/declarative/pattern.js';

describe('pattern parser accepts rest-url-normalise transform', () => {
  it('parses a pattern declaring transform: rest-url-normalise', () => {
    const r = parsePattern({
      match: { lang: 'ts', nodeKind: 'method-call', name: 'get', receiver: 'request' },
      bind: { url: { arg: 0, type: 'string' } },
      emit: 'rest-call-js',
      anchor: { template: 'rest:GET {url}', role: 'target' },
      transform: 'rest-url-normalise',
    });
    expect(r.kind).toBe('ok');
  });
});
