import type { UserPattern } from './pattern.js';

// Anchor templates are interpolated server-side (PHP worker). Field names in
// {curlies} reference payload fields produced by the binding step.
export interface PhpPatternWithAnchor extends UserPattern {
  readonly anchor: { readonly template: string; readonly role: 'subject' | 'target' };
}

export const WP_PHP_PATTERNS: readonly PhpPatternWithAnchor[] = [
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'add_action' },
    bind: {
      hook: { arg: 0, type: 'string' },
      callback: { arg: 1, type: 'callable', optional: true },
      priority: { arg: 2, type: 'int', optional: true },
    },
    emit: 'hook-listener',
    anchor: { template: 'hook:{hook}', role: 'subject' },
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'add_filter' },
    bind: {
      hook: { arg: 0, type: 'string' },
      callback: { arg: 1, type: 'callable', optional: true },
      priority: { arg: 2, type: 'int', optional: true },
    },
    emit: 'hook-listener',
    anchor: { template: 'hook:{hook}', role: 'subject' },
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'do_action' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-fire',
    anchor: { template: 'hook:{hook}', role: 'target' },
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'apply_filters' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-fire',
    anchor: { template: 'hook:{hook}', role: 'target' },
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'register_rest_route' },
    bind: {
      namespace: { arg: 0, type: 'string' },
      route: { arg: 1, type: 'string' },
    },
    emit: 'rest-endpoint',
    anchor: { template: 'rest:GET /{namespace}{route}', role: 'subject' },
    transform: 'rest-route',
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'wp_enqueue_script' },
    bind: {
      handle: { arg: 0, type: 'string' },
      src: { arg: 1, type: 'string', optional: true },
    },
    emit: 'enqueue-script',
    anchor: { template: 'script-handle:{handle}', role: 'subject' },
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'wp_register_script' },
    bind: {
      handle: { arg: 0, type: 'string' },
      src: { arg: 1, type: 'string', optional: true },
    },
    emit: 'enqueue-script',
    anchor: { template: 'script-handle:{handle}', role: 'subject' },
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'wp_localize_script' },
    bind: { handle: { arg: 0, type: 'string' } },
    emit: 'script-localize',
    anchor: { template: 'script-handle:{handle}', role: 'subject' },
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'add_shortcode' },
    bind: { tag: { arg: 0, type: 'string' }, callback: { arg: 1, type: 'callable', optional: true } },
    emit: 'shortcode',
    anchor: { template: 'shortcode:{tag}', role: 'subject' },
  },
  {
    match: { lang: 'php', nodeKind: 'function-call', name: 'register_block_type' },
    bind: { name: { arg: 0, type: 'string' } },
    emit: 'block-render',
    anchor: { template: 'block:{name}', role: 'subject' },
  },
];
