import type { Fact, FactAnchorRef, FactLocation } from '../../facts/types.js';
import type { AnchorKey } from '../../types.js';

const AJAX_RE = /^wp_ajax_(?:nopriv_)?(.+)$/;

export function deriveAjaxListeners(facts: readonly Fact[]): Fact[] {
  const out: Fact[] = [];
  for (const f of facts) {
    if (f.kind !== 'hook-listener') continue;
    const hook = (f.payload as { hook?: unknown }).hook;
    if (typeof hook !== 'string') continue;
    const m = AJAX_RE.exec(hook);
    if (!m) continue;
    const action = m[1];
    if (action === undefined) continue;
    const callback = (f.payload as { callback?: unknown }).callback;
    const anchors: FactAnchorRef[] = [{ key: `ajax:${action}` as AnchorKey, role: 'subject' }];
    const location: FactLocation = { ...f.location };
    out.push({
      kind: 'ajax-listener',
      resolved: f.resolved,
      location,
      anchors,
      payload: {
        kind: 'ajax-listener',
        action,
        ...(typeof callback === 'string' ? { callback } : {}),
      },
    });
  }
  return out;
}
