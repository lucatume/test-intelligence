import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { runDeclarativePatterns } from '../../../src/extract/declarative/engine.js';
import type { UserPattern } from '../../../src/extract/declarative/pattern.js';

function parse(rel: string, src: string): ts.SourceFile {
  return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe('runDeclarativePatterns', () => {
  it('matches function-call by name and binds an object arg', () => {
    const sf = parse('src/a.ts', "apiFetch({ path: '/myplugin/v1/items' });");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'apiFetch' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'rest-call-js',
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.kind).toBe('rest-call-js');
  });

  it('matches method-call with receiver constraint', () => {
    const sf = parse('src/a.ts', "jQuery.post(url, data);");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: 'jQuery' },
      bind: {},
      emit: 'ajax-call-js',
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
  });

  it('does not match when receiver differs', () => {
    const sf = parse('src/a.ts', "axios.post(url);");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: 'jQuery' },
      bind: {},
      emit: 'ajax-call-js',
    };
    expect(runDeclarativePatterns(sf, 'src/a.ts', [pattern])).toEqual([]);
  });

  it('marks fact resolved=false when a string binding sees a variable', () => {
    const sf = parse('src/a.ts', "apiFetch(opts);");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'apiFetch' },
      bind: { config: { arg: 0, type: 'string' } },
      emit: 'rest-call-js',
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.resolved).toBe(false);
  });

  it('emits no facts when no patterns are passed', () => {
    const sf = parse('src/a.ts', "apiFetch('/x');");
    expect(runDeclarativePatterns(sf, 'src/a.ts', [])).toEqual([]);
  });
});
