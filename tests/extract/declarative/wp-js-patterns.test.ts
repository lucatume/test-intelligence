import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { runDeclarativePatterns } from '../../../src/extract/declarative/engine.js';
import { WP_JS_PATTERNS } from '../../../src/extract/declarative/wp-js-patterns.js';
import { parseAnchor } from '../../../src/anchors/parse.js';

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

  it('strips /wp-json/ prefix from a fetch literal URL', () => {
    const sf = parse('src/a.ts', "fetch('/wp-json/wc/v3/products');");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const rc = facts.find((f) => f.kind === 'rest-call-js');
    expect(rc).toBeDefined();
    const raw = rc?.anchors[0]?.key ?? '';
    const parsed = parseAnchor(raw);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.value.key).toBe('rest:GET /wc/v3/products');
  });

  it('emits hook-listener for addAction(name, namespace, cb)', () => {
    const sf = parse(
      'src/a.ts',
      "import { addAction } from '@wordpress/hooks'; addAction('my_event', 'my-ns', () => {});",
    );
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const list = facts.filter((f) => f.kind === 'hook-listener');
    expect(list).toHaveLength(1);
    expect(list[0]?.anchors[0]?.key).toBe('hook:my_event');
  });

  it('emits hook-fire for doAction("my_event")', () => {
    const sf = parse(
      'src/a.ts',
      "import { doAction } from '@wordpress/hooks'; doAction('my_event', payload);",
    );
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect(fire?.anchors[0]?.key).toBe('hook:my_event');
  });

  it('emits hook-fire for applyFilters', () => {
    const sf = parse('src/a.ts', "applyFilters('the_value', x);");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect(fire?.anchors[0]?.key).toBe('hook:the_value');
  });

  it('emits hook-listener for wp.hooks.addAction (two-segment receiver)', () => {
    const sf = parse('src/a.ts', "wp.hooks.addAction('my_event', 'ns', cb);");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const list = facts.filter((f) => f.kind === 'hook-listener');
    expect(list).toHaveLength(1);
    expect(list[0]?.anchors[0]?.key).toBe('hook:my_event');
  });

  it('emits hook-listener for destructured hooks.addAction', () => {
    const sf = parse('src/a.ts', "const { hooks } = wp; hooks.addAction('my_event', 'ns', cb);");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const list = facts.filter((f) => f.kind === 'hook-listener');
    expect(list).toHaveLength(1);
  });
});
