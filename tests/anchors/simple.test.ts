import { describe, expect, it } from 'vitest';
import { parseAnchor } from '../../src/anchors/parse.js';
import type { Anchor, SimpleAnchor } from '../../src/anchors/types.js';

function expectSimpleAnchorOfType<T extends SimpleAnchor['type']>(
  a: Anchor,
  expected: T,
): SimpleAnchor & { type: T } {
  expect(a.type).toBe(expected);
  if (a.type !== expected) throw new Error('unreachable');
  return a as SimpleAnchor & { type: T };
}

describe('parseAnchor — ajax', () => {
  it('strips wp_ajax_ prefix', () => {
    const r = parseAnchor('ajax:wp_ajax_my_action');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = expectSimpleAnchorOfType(r.value, 'ajax');
    expect(v.body).toBe('my_action');
    expect(v.key).toBe('ajax:my_action');
  });

  it('strips wp_ajax_nopriv_ prefix', () => {
    const r = parseAnchor('ajax:wp_ajax_nopriv_my_action');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = expectSimpleAnchorOfType(r.value, 'ajax');
    expect(v.body).toBe('my_action');
  });

  it('passes through action with no prefix', () => {
    const r = parseAnchor('ajax:my_action');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = expectSimpleAnchorOfType(r.value, 'ajax');
    expect(v.body).toBe('my_action');
  });

  it('preserves case (WP semantics)', () => {
    const r = parseAnchor('ajax:MyAction');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = expectSimpleAnchorOfType(r.value, 'ajax');
    expect(v.body).toBe('MyAction');
  });
});

describe('parseAnchor — php-symbol', () => {
  it('drops leading backslash', () => {
    const r = parseAnchor('php-symbol:\\Acme\\Cart::addItem');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = expectSimpleAnchorOfType(r.value, 'php-symbol');
    expect(v.body).toBe('Acme\\Cart::addItem');
    expect(v.key).toBe('php-symbol:Acme\\Cart::addItem');
  });

  it('keeps namespace as-is when no leading backslash', () => {
    const r = parseAnchor('php-symbol:Acme\\Cart::addItem');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const v = expectSimpleAnchorOfType(r.value, 'php-symbol');
    expect(v.body).toBe('Acme\\Cart::addItem');
  });
});

describe('parseAnchor — pass-through anchors', () => {
  const cases: Array<[string, string]> = [
    ['hook:init', 'init'],
    ['js-symbol:./cart.ts:addItem', './cart.ts:addItem'],
    ['js-module:./helpers.ts', './helpers.ts'],
    ['php-file:src/Cart.php', 'src/Cart.php'],
    ['script-handle:cart-ui', 'cart-ui'],
    ['shortcode:my_tag', 'my_tag'],
    ['block:myplugin/cart', 'myplugin/cart'],
    ['test:phpunit:tests/Cart.php::add', 'phpunit:tests/Cart.php::add'],
  ];
  for (const [raw, body] of cases) {
    it(`parses ${raw}`, () => {
      const r = parseAnchor(raw);
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      expect(r.value.type).not.toBe('rest');
      if (r.value.type === 'rest') return;
      expect(r.value.body).toBe(body);
      expect(r.value.key).toBe(`${r.value.type}:${body}`);
    });
  }
});

describe('parseAnchor — wildcard marker {*}', () => {
  it('marks a hook anchor as partial when body contains {*}', () => {
    const r = parseAnchor('hook:woocommerce_{*}_x');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.type).toBe('hook');
    expect((r.value as { partial?: boolean }).partial).toBe(true);
  });

  it('leaves a hook anchor partial:false when no {*}', () => {
    const r = parseAnchor('hook:init');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect((r.value as { partial?: boolean }).partial ?? false).toBe(false);
  });

  it('marks an ajax anchor partial when body contains {*}', () => {
    const r = parseAnchor('ajax:save_{*}');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect((r.value as { partial?: boolean }).partial).toBe(true);
  });
});

describe('parseAnchor — rejection', () => {
  it('rejects unknown type', () => {
    const r = parseAnchor('nope:foo');
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.reason).toContain('unknown anchor type');
    expect(r.error.raw).toBe('nope:foo');
  });

  it('rejects empty body', () => {
    const r = parseAnchor('hook:');
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.reason).toContain('empty body');
  });

  it('rejects missing colon', () => {
    const r = parseAnchor('init');
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.reason).toContain('missing');
  });

  it('rejects bare ajax prefix', () => {
    const r = parseAnchor('ajax:wp_ajax_');
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.reason).toContain('empty ajax action');
  });

  it('rejects bare ajax nopriv prefix', () => {
    const r = parseAnchor('ajax:wp_ajax_nopriv_');
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.reason).toContain('empty ajax action');
  });
});
