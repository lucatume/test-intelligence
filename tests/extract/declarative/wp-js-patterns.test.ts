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

  it('matches $.ajax({url, data:{action}})', () => {
    const sf = parse('src/a.ts', "$.ajax({ url: ajaxurl, data: { action: 'wc_x' } });");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const ajax = facts.find((f) => f.kind === 'ajax-call-js');
    expect(ajax?.anchors[0]?.key).toBe('ajax:wc_x');
    expect(ajax?.resolved).toBe(true);
  });

  it('matches $.get(url, {action})', () => {
    const sf = parse('src/a.ts', "$.get(ajaxurl, { action: 'wc_get' });");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const ajax = facts.find((f) => f.kind === 'ajax-call-js');
    expect(ajax?.anchors[0]?.key).toBe('ajax:wc_get');
  });

  it('matches $.getJSON(url, {action})', () => {
    const sf = parse('src/a.ts', "$.getJSON(ajaxurl, { action: 'wc_json' });");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const ajax = facts.find((f) => f.kind === 'ajax-call-js');
    expect(ajax?.anchors[0]?.key).toBe('ajax:wc_json');
  });

  it('matches Backbone.ajax({url, data:{action}}) as an $.ajax alias', () => {
    const sf = parse('src/a.ts', "Backbone.ajax({ url: ajaxurl, data: { action: 'wc_bb' } });");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const ajax = facts.find((f) => f.kind === 'ajax-call-js');
    expect(ajax?.anchors[0]?.key).toBe('ajax:wc_bb');
  });

  it('matches jQuery.get(url, {action})', () => {
    const sf = parse('src/a.ts', "jQuery.get(ajaxurl, { action: 'wc_jqget' });");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const ajax = facts.find((f) => f.kind === 'ajax-call-js');
    expect(ajax?.anchors[0]?.key).toBe('ajax:wc_jqget');
  });

  it('extracts the action from a concatenated $.post URL', () => {
    const sf = parse(
      'src/a.ts',
      "$.post( ajaxurl + '?action=woocommerce_shipping_zones_save_changes', { changes: x } );",
    );
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const ajax = facts.find(
      (f) =>
        f.kind === 'ajax-call-js' &&
        f.anchors[0]?.key === 'ajax:woocommerce_shipping_zones_save_changes',
    );
    expect(ajax).toBeDefined();
    expect(ajax?.resolved).toBe(true);
  });

  it('leaves the action unresolved when a concatenated URL has no action token', () => {
    const sf = parse('src/a.ts', "$.post( ajaxurl + '?foo=bar', { x: 1 } );");
    const facts = runDeclarativePatterns(sf, 'src/a.ts', WP_JS_PATTERNS);
    const ajaxByUrl = facts.filter(
      (f) => f.kind === 'ajax-call-js' && f.resolved && (f.anchors[0]?.key ?? '').startsWith('ajax:'),
    );
    expect(ajaxByUrl.every((f) => f.anchors[0]?.key !== 'ajax:foo')).toBe(true);
  });

  it('extracts a resolved ajax-call-js from a classic IIFE with var-data $.ajax', () => {
    const src = [
      '( function( $ ) {',
      '  $( function() {',
      "    var data = { action: 'woocommerce_get_customer_details', security: nonce };",
      "    $.ajax({ url: woocommerce_admin_meta_boxes.ajax_url, data: data, type: 'POST' });",
      '  } );',
      '} )( jQuery );',
    ].join('\n');
    const sf = parse('src/admin.ts', src);
    const facts = runDeclarativePatterns(sf, 'src/admin.ts', WP_JS_PATTERNS);
    const ajax = facts.find((f) => f.kind === 'ajax-call-js' && f.resolved);
    expect(ajax?.anchors[0]?.key).toBe('ajax:woocommerce_get_customer_details');
  });

  it('extracts an admin-page-nav fact from page.goto with a page= slug', () => {
    const sf = parse(
      'tests/e2e-pw/settings.spec.ts',
      "page.goto('wp-admin/admin.php?page=wc-settings');",
    );
    const facts = runDeclarativePatterns(sf, 'tests/e2e-pw/settings.spec.ts', WP_JS_PATTERNS);
    const nav = facts.filter((f) => f.kind === 'admin-page-nav');
    expect(nav).toHaveLength(1);
    expect(nav[0]?.payload).toMatchObject({
      kind: 'admin-page-nav',
      slug: 'wc-settings',
      method: 'goto',
      url: 'wp-admin/admin.php?page=wc-settings',
    });
    expect(nav[0]?.anchors).toEqual([{ key: 'wp-admin-page:wc-settings', role: 'target' }]);
    expect(nav[0]?.resolved).toBe(true);
  });

  it('does not emit admin-page-nav for a wp-admin URL with no page= param', () => {
    const sf = parse(
      'tests/e2e-pw/products.spec.ts',
      "page.goto('wp-admin/edit.php?post_type=product');",
    );
    const facts = runDeclarativePatterns(sf, 'tests/e2e-pw/products.spec.ts', WP_JS_PATTERNS);
    expect(facts.filter((f) => f.kind === 'admin-page-nav')).toHaveLength(0);
  });

  it('extracts admin-page-nav from page.route with a page= slug', () => {
    const sf = parse(
      'tests/e2e-pw/intercept.spec.ts',
      "page.route('wp-admin/admin.php?page=wc-orders', () => {});",
    );
    const facts = runDeclarativePatterns(sf, 'tests/e2e-pw/intercept.spec.ts', WP_JS_PATTERNS);
    const nav = facts.filter((f) => f.kind === 'admin-page-nav');
    expect(nav).toHaveLength(1);
    expect(nav[0]?.payload).toMatchObject({ slug: 'wc-orders', method: 'route' });
    expect(nav[0]?.anchors[0]?.key).toBe('wp-admin-page:wc-orders');
  });

  it('extracts a resolved ajax-call-js from a Backbone.ajax call in an IIFE', () => {
    const src = [
      '( function( $ ) {',
      '  var APIView = Backbone.View.extend({',
      '    save: function() {',
      '      Backbone.ajax({',
      "        method: 'POST',",
      '        url: woocommerce_admin_api_keys.ajax_url,',
      "        data: { action: 'woocommerce_update_api_key', security: nonce }",
      '      });',
      '    }',
      '  });',
      '} )( jQuery );',
    ].join('\n');
    const sf = parse('src/admin.ts', src);
    const facts = runDeclarativePatterns(sf, 'src/admin.ts', WP_JS_PATTERNS);
    const ajax = facts.find((f) => f.kind === 'ajax-call-js' && f.resolved);
    expect(ajax?.anchors[0]?.key).toBe('ajax:woocommerce_update_api_key');
  });

  it('emits store-register for registerStore(key, config)', () => {
    const sf = parse('src/store.ts', "registerStore('wc/admin/plugins', { reducer });");
    const facts = runDeclarativePatterns(sf, 'src/store.ts', WP_JS_PATTERNS);
    const f = facts.find((x) => x.kind === 'store-register');
    expect(f?.resolved).toBe(true);
    expect(f?.anchors[0]?.key).toBe('wp-store:wc/admin/plugins');
    expect(f?.anchors[0]?.role).toBe('subject');
  });

  it('emits store-register for createReduxStore(key, config)', () => {
    const sf = parse('src/store.ts', "const store = createReduxStore('wc/admin/orders', { reducer });");
    const facts = runDeclarativePatterns(sf, 'src/store.ts', WP_JS_PATTERNS);
    const f = facts.find((x) => x.kind === 'store-register');
    expect(f?.anchors[0]?.key).toBe('wp-store:wc/admin/orders');
  });

  it('resolves createReduxStore with a same-file STORE_NAME const', () => {
    const sf = parse(
      'src/store.ts',
      "const STORE_NAME = 'wc/admin/options'; const store = createReduxStore(STORE_NAME, {});",
    );
    const facts = runDeclarativePatterns(sf, 'src/store.ts', WP_JS_PATTERNS);
    const f = facts.find((x) => x.kind === 'store-register');
    expect(f?.resolved).toBe(true);
    expect(f?.anchors[0]?.key).toBe('wp-store:wc/admin/options');
  });

  it('emits store-access for useDispatch("core/notices")', () => {
    const sf = parse('src/c.tsx', "const { createNotice } = useDispatch('core/notices');");
    const facts = runDeclarativePatterns(sf, 'src/c.tsx', WP_JS_PATTERNS);
    const f = facts.find((x) => x.kind === 'store-access');
    expect(f?.resolved).toBe(true);
    expect(f?.anchors[0]?.key).toBe('wp-store:core/notices');
    expect(f?.anchors[0]?.role).toBe('target');
  });

  it('emits store-access for the nested select() inside a useSelect callback', () => {
    const sf = parse(
      'src/c.tsx',
      "const x = useSelect( ( select ) => select('core/editor').getCurrentPost() );",
    );
    const facts = runDeclarativePatterns(sf, 'src/c.tsx', WP_JS_PATTERNS);
    const f = facts.find((x) => x.kind === 'store-access');
    expect(f?.anchors[0]?.key).toBe('wp-store:core/editor');
  });

  it('emits store-access for a bare dispatch("core/x") call', () => {
    const sf = parse('src/c.tsx', "dispatch('core/block-editor').selectBlock( id );");
    const facts = runDeclarativePatterns(sf, 'src/c.tsx', WP_JS_PATTERNS);
    const f = facts.find((x) => x.kind === 'store-access');
    expect(f?.anchors[0]?.key).toBe('wp-store:core/block-editor');
  });

  it('emits a block-render target fact for registerBlockType("ns/name", ...)', () => {
    const sf = parse('src/block.tsx', "registerBlockType('woocommerce/cart', { edit, save });");
    const facts = runDeclarativePatterns(sf, 'src/block.tsx', WP_JS_PATTERNS);
    const f = facts.find((x) => x.kind === 'block-render');
    expect(f?.resolved).toBe(true);
    expect(f?.anchors[0]?.key).toBe('block:woocommerce/cart');
    expect(f?.anchors[0]?.role).toBe('target');
  });

  it('produces no store-access anchor when useDispatch arg is an identifier', () => {
    const sf = parse('src/c.tsx', "const d = useDispatch( noticesStore );");
    const facts = runDeclarativePatterns(sf, 'src/c.tsx', WP_JS_PATTERNS);
    const withAnchor = facts.filter((x) => x.kind === 'store-access' && x.anchors.length > 0);
    expect(withAnchor).toHaveLength(0);
  });
});
