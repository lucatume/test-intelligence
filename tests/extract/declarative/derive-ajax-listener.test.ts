import { describe, it, expect } from 'vitest';
import { deriveAjaxListeners } from '../../../src/extract/declarative/derive-ajax-listener.js';
import type { Fact } from '../../../src/facts/types.js';
import type { AnchorKey, SourcePath } from '../../../src/types.js';
import { unsafeCoerce } from '../../helpers/unsafeCoerce.js';

const mk = (hook: string): Fact => ({
  kind: 'hook-listener',
  resolved: true,
  location: { file: unsafeCoerce<SourcePath>('plugin.php'), startLine: 1, endLine: 1 },
  anchors: [{ key: unsafeCoerce<AnchorKey>(`hook:${hook}`), role: 'subject' }],
  payload: { kind: 'hook-listener', hook, callback: 'do_thing' },
});

describe('deriveAjaxListeners', () => {
  it('promotes wp_ajax_x to ajax-listener:x', () => {
    const out = deriveAjaxListeners([mk('wp_ajax_my_action')]);
    expect(out).toHaveLength(1);
    const [f] = out;
    if (!f) throw new Error('no fact');
    const [a] = f.anchors;
    if (!a) throw new Error('no anchor');
    expect(a.key).toBe('ajax:my_action');
  });

  it('promotes wp_ajax_nopriv_x to the same anchor', () => {
    const out = deriveAjaxListeners([mk('wp_ajax_nopriv_my_action')]);
    const [f] = out;
    if (!f) throw new Error('no fact');
    const [a] = f.anchors;
    if (!a) throw new Error('no anchor');
    expect(a.key).toBe('ajax:my_action');
  });

  it('ignores hooks not matching wp_ajax_*', () => {
    expect(deriveAjaxListeners([mk('init')])).toEqual([]);
  });
});
