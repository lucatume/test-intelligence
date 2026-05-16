import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../../src/extract/declarative/pattern.js';

describe('parsePattern', () => {
  it('accepts a minimal function-call pattern', () => {
    const r = parsePattern({
      match: { lang: 'js', nodeKind: 'function-call', name: 'apiFetch' },
      bind: {
        path: { arg: 0, type: 'string' },
      },
      emit: 'rest-call-js',
    });
    expect(r.kind).toBe('ok');
  });

  it('rejects bad nodeKind', () => {
    const r = parsePattern({
      match: { lang: 'js', nodeKind: 'lol', name: 'x' },
      bind: {},
      emit: 'rest-call-js',
    });
    expect(r.kind).toBe('err');
  });

  it('rejects bad emit kind', () => {
    const r = parsePattern({
      match: { lang: 'js', nodeKind: 'function-call', name: 'apiFetch' },
      bind: {},
      emit: 'totally-fake',
    });
    expect(r.kind).toBe('err');
  });

  it('accepts method-call with receiver', () => {
    const r = parsePattern({
      match: { lang: 'js', nodeKind: 'method-call', name: 'post', receiver: 'jQuery' },
      bind: { url: { arg: 0, type: 'string' } },
      emit: 'ajax-call-js',
    });
    expect(r.kind).toBe('ok');
  });

  it('accepts the ajax-action-from-url transform', () => {
    const r = parsePattern({
      match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: '$' },
      bind: { url: { arg: 0, type: 'string' } },
      emit: 'ajax-call-js',
      transform: 'ajax-action-from-url',
    });
    expect(r.kind).toBe('ok');
  });
});
