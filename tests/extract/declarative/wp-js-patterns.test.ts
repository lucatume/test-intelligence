import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { runDeclarativePatterns } from '../../../src/extract/declarative/engine.js';
import { WP_JS_PATTERNS } from '../../../src/extract/declarative/wp-js-patterns.js';

function parse(rel: string, src: string): ts.SourceFile {
  return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe('WP_JS_PATTERNS', () => {
  it('matches apiFetch({path})', () => {
    const sf = parse('src/a.ts', "apiFetch({ path: '/myplugin/v1/items' });");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const rest = facts.find((f) => f.kind === 'rest-call-js');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /myplugin/v1/items');
  });

  it('matches fetch(/wp-json/...)', () => {
    const sf = parse('src/a.ts', "fetch('/wp-json/myplugin/v1/items');");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const rest = facts.find((f) => f.kind === 'rest-call-js');
    expect(rest?.anchors[0]?.key).toBe('rest:GET /wp-json/myplugin/v1/items');
  });

  it('matches jQuery.ajax({url, data:{action}})', () => {
    const sf = parse('src/a.ts', "jQuery.ajax({ url: ajaxurl, data: { action: 'my_action' } });");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const ajax = facts.find((f) => f.kind === 'ajax-call-js');
    expect(ajax?.anchors[0]?.key).toBe('ajax:my_action');
  });

  it('matches axios.post(url)', () => {
    const sf = parse('src/a.ts', "axios.post('/wp-json/x/v1/items');");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const rest = facts.find((f) => f.kind === 'rest-call-js');
    expect(rest?.anchors[0]?.key).toBe('rest:POST /wp-json/x/v1/items');
  });
});
