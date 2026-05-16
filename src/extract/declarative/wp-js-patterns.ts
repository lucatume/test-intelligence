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
];
