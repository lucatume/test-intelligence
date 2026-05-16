import type { UserPattern } from './pattern.js';

const AXIOS_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const axiosPatterns: readonly UserPattern[] = AXIOS_METHODS.map((method) => ({
  match: { lang: 'ts' as const, nodeKind: 'method-call' as const, name: method, receiver: 'axios' },
  bind: { url: { arg: 0, type: 'string' as const } },
  emit: 'rest-call-js' as const,
  anchor: { template: `rest:${method.toUpperCase()} {url}`, role: 'target' as const },
}));

export const WP_JS_PATTERNS: readonly UserPattern[] = [
  // apiFetch({ path: '/myplugin/v1/items' }) — @wordpress/api-fetch
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'apiFetch' },
    bind: { config: { arg: 0, type: 'object' } },
    emit: 'rest-call-js',
    anchor: { template: 'rest:GET {config.path}', role: 'target' },
  },
  // fetch('/wp-json/myplugin/v1/items', { method: 'POST' })
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'fetch' },
    bind: { url: { arg: 0, type: 'string' }, init: { arg: 1, type: 'object', optional: true } },
    emit: 'rest-call-js',
    anchor: { template: 'rest:GET {url}', role: 'target' },
  },
  ...axiosPatterns,
  // jQuery.ajax({ url: ajaxurl, data: { action: 'x' } }) and $.post(ajaxurl, { action })
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'ajax', receiver: 'jQuery' },
    bind: { config: { arg: 0, type: 'object' } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{config.data.action}', role: 'target' },
  },
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: 'jQuery' },
    bind: { url: { arg: 0, type: 'string', optional: true }, data: { arg: 1, type: 'object', optional: true } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{data.action}', role: 'target' },
  },
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: '$' },
    bind: { url: { arg: 0, type: 'string', optional: true }, data: { arg: 1, type: 'object', optional: true } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{data.action}', role: 'target' },
  },
  // $.post( ajaxurl + 'action=wc_x', data ) — action lives in the URL string
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: '$' },
    bind: { url: { arg: 0, type: 'string', optional: true } },
    emit: 'ajax-call-js',
    transform: 'ajax-action-from-url',
    anchor: { template: 'ajax:{action}', role: 'target' },
  },
  // wp.ajax.post('my_action', data)
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: 'ajax' },
    bind: { action: { arg: 0, type: 'string' } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{action}', role: 'target' },
  },
  // $.ajax({ url, data: { action } }) — classic jQuery AJAX
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'ajax', receiver: '$' },
    bind: { config: { arg: 0, type: 'object' } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{config.data.action}', role: 'target' },
  },
  // Backbone.ajax({ url, data: { action } }) — thin alias of $.ajax
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'ajax', receiver: 'Backbone' },
    bind: { config: { arg: 0, type: 'object' } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{config.data.action}', role: 'target' },
  },
  // $.get(ajaxurl, { action }) / jQuery.get(...) / $.getJSON(...) / jQuery.getJSON(...)
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'get', receiver: '$' },
    bind: { url: { arg: 0, type: 'string', optional: true }, data: { arg: 1, type: 'object', optional: true } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{data.action}', role: 'target' },
  },
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'get', receiver: 'jQuery' },
    bind: { url: { arg: 0, type: 'string', optional: true }, data: { arg: 1, type: 'object', optional: true } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{data.action}', role: 'target' },
  },
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'getJSON', receiver: '$' },
    bind: { url: { arg: 0, type: 'string', optional: true }, data: { arg: 1, type: 'object', optional: true } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{data.action}', role: 'target' },
  },
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'getJSON', receiver: 'jQuery' },
    bind: { url: { arg: 0, type: 'string', optional: true }, data: { arg: 1, type: 'object', optional: true } },
    emit: 'ajax-call-js',
    anchor: { template: 'ajax:{data.action}', role: 'target' },
  },
  // @wordpress/hooks named-import form
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'addAction' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-listener',
    anchor: { template: 'hook:{hook}', role: 'subject' },
  },
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'addFilter' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-listener',
    anchor: { template: 'hook:{hook}', role: 'subject' },
  },
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'doAction' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-fire',
    anchor: { template: 'hook:{hook}', role: 'target' },
  },
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'applyFilters' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-fire',
    anchor: { template: 'hook:{hook}', role: 'target' },
  },
  // hooks.* method-call form (also covers wp.hooks.* via two-segment receiver)
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'addAction', receiver: 'hooks' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-listener',
    anchor: { template: 'hook:{hook}', role: 'subject' },
  },
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'addFilter', receiver: 'hooks' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-listener',
    anchor: { template: 'hook:{hook}', role: 'subject' },
  },
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'doAction', receiver: 'hooks' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-fire',
    anchor: { template: 'hook:{hook}', role: 'target' },
  },
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'applyFilters', receiver: 'hooks' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-fire',
    anchor: { template: 'hook:{hook}', role: 'target' },
  },
  // --- @wordpress/data store bridge ----------------------------------------
  // Registration side. registerStore('wc/admin/x', config) /
  // createReduxStore('wc/admin/x', config) + register(store). Arg 0 is the
  // string key; a same-file `const STORE_NAME = '…'` resolves via the engine's
  // literal-init map. An identifier from another file stays unresolved → no
  // anchor → inert in derive.
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'registerStore' },
    bind: { key: { arg: 0, type: 'string' } },
    emit: 'store-register',
    anchor: { template: 'wp-store:{key}', role: 'subject' },
  },
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'createReduxStore' },
    bind: { key: { arg: 0, type: 'string' } },
    emit: 'store-register',
    anchor: { template: 'wp-store:{key}', role: 'subject' },
  },
  // Access side. useDispatch('core/notices') — key is arg 0. The nested
  // select('…') inside a useSelect callback is matched by the `select` rule
  // below (the engine walks every node), so useSelect needs no rule of its own.
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'useDispatch' },
    bind: { key: { arg: 0, type: 'string' } },
    emit: 'store-access',
    anchor: { template: 'wp-store:{key}', role: 'target' },
  },
  // Bare select('key') / dispatch('key') imported from @wordpress/data, and the
  // select(...) call nested in a useSelect callback. `select`/`dispatch` are
  // generic names: a call whose arg 0 is NOT a string literal binds to null and
  // produces no anchor, so an over-match is inert. Matching the name is safe
  // BECAUSE the anchor only materialises for a literal key.
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'select' },
    bind: { key: { arg: 0, type: 'string' } },
    emit: 'store-access',
    anchor: { template: 'wp-store:{key}', role: 'target' },
  },
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'dispatch' },
    bind: { key: { arg: 0, type: 'string' } },
    emit: 'store-access',
    anchor: { template: 'wp-store:{key}', role: 'target' },
  },
  // registerBlockType('woocommerce/cart', { edit, save }) — @wordpress/blocks.
  // The JS side of a block. Emitted as a block-render TARGET so it joins the
  // PHP register_block_type SUBJECT facts on the block:<ns>/<name> anchor: a
  // block's JS edit/save component depends on the PHP that renders the block.
  // This is the block-render bridge's fire side; without it the PHP subject
  // facts have no partner and the block-render edge kind produces nothing.
  {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'registerBlockType' },
    bind: { name: { arg: 0, type: 'string' } },
    emit: 'block-render',
    anchor: { template: 'block:{name}', role: 'target' },
  },
  // page.goto('/wp-admin/admin.php?page=wc-settings') — Playwright navigation
  // (program Phase 5). The admin-page-slug-from-url transform extracts the
  // page= slug; a URL with no page= slug emits no fact.
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'goto', receiver: 'page' },
    bind: { url: { arg: 0, type: 'string' } },
    emit: 'admin-page-nav',
    transform: 'admin-page-slug-from-url',
    anchor: { template: 'wp-admin-page:{slug}', role: 'target' },
  },
  // page.route('/wp-admin/admin.php?page=wc-orders', handler) — URL interception
  {
    match: { lang: 'ts', nodeKind: 'method-call', name: 'route', receiver: 'page' },
    bind: { url: { arg: 0, type: 'string' } },
    emit: 'admin-page-nav',
    transform: 'admin-page-slug-from-url',
    anchor: { template: 'wp-admin-page:{slug}', role: 'target' },
  },
];
