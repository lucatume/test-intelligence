import type { AnchorKey, FactKind, SourcePath, TestFilePath } from '../types.js';

// Role each anchor plays for a fact. Sealed; producers must use one of these.
export type AnchorRole = 'subject' | 'target' | 'callback' | 'module';

export interface FactAnchorRef {
  readonly key: AnchorKey;
  readonly role: AnchorRole;
}

export interface FactLocation {
  readonly file: SourcePath | TestFilePath;
  readonly startLine: number;
  readonly endLine: number;
}

// Per-kind payloads. Each FactKind has exactly one payload shape — discriminated
// by `kind`. Fields are the minimum the derivation engine needs.

export interface SymbolDefPayload {
  readonly kind: 'symbol-def';
  readonly name: string;
  readonly exported: boolean;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface SymbolUsePayload {
  readonly kind: 'symbol-use';
  readonly name: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ImportEdgePayload {
  readonly kind: 'import-edge';
  readonly specifier: string;
  readonly resolved: boolean;
  readonly resolvedPath?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface PhpIncludePayload {
  readonly kind: 'php-include';
  readonly target: string;
}

export interface HookListenerPayload {
  readonly kind: 'hook-listener';
  readonly hook: string;
  readonly priority?: number;
  readonly callback?: string;
}

export interface HookFirePayload {
  readonly kind: 'hook-fire';
  readonly hook: string;
}

export interface RestEndpointPayload {
  readonly kind: 'rest-endpoint';
  readonly method: string;
  readonly route: string;
  readonly callback?: string;
  /** Set true when the route carried a normalized regex param (`(?P<id>…)` → `{*}`). */
  readonly routeParam?: boolean;
  /** Present on facts left unresolved by a `$this->prop` miss — context for the
   *  cross-file resolver: the enclosing class FQN and the unresolved property names. */
  readonly unresolved?: {
    readonly class: string | null;
    readonly fields: readonly string[];
  };
}

export interface RestCallJsPayload {
  readonly kind: 'rest-call-js';
  readonly method: string;
  readonly route: string;
}

export interface AjaxListenerPayload {
  readonly kind: 'ajax-listener';
  readonly action: string;
  readonly callback?: string;
}

export interface AjaxCallJsPayload {
  readonly kind: 'ajax-call-js';
  readonly action: string;
}

export interface EnqueueScriptPayload {
  readonly kind: 'enqueue-script';
  readonly handle: string;
  readonly src?: string;
  readonly resolvedJsModule?: string;
}

export interface AdminPageNavPayload {
  readonly kind: 'admin-page-nav';
  readonly url: string;
  readonly slug: string;
  readonly method: 'goto' | 'route';
}

export interface AdminPageRegisterPayload {
  readonly kind: 'admin-page-register';
  readonly slug: string;
  readonly fn: 'add_menu_page' | 'add_submenu_page';
}

export interface ScriptLocalizePayload {
  readonly kind: 'script-localize';
  readonly handle: string;
}

export interface ScriptLocalizeInlinePayload {
  readonly kind: 'script-localize-inline';
  readonly handle: string;
}

export interface ShortcodePayload {
  readonly kind: 'shortcode';
  readonly tag: string;
  readonly callback?: string;
}

export interface BlockRenderPayload {
  readonly kind: 'block-render';
  readonly name: string;
  readonly callback?: string;
}

export interface TestDefPayload {
  readonly kind: 'test-def';
  readonly framework: 'phpunit' | 'jest' | 'playwright';
  readonly testId: string;
  readonly title?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ParseErrorPayload {
  readonly kind: 'parse-error';
  readonly message: string;
  readonly line?: number;
}

export type FactPayload =
  | SymbolDefPayload
  | SymbolUsePayload
  | ImportEdgePayload
  | PhpIncludePayload
  | HookListenerPayload
  | HookFirePayload
  | RestEndpointPayload
  | RestCallJsPayload
  | AjaxListenerPayload
  | AjaxCallJsPayload
  | EnqueueScriptPayload
  | AdminPageNavPayload
  | AdminPageRegisterPayload
  | ScriptLocalizePayload
  | ScriptLocalizeInlinePayload
  | ShortcodePayload
  | BlockRenderPayload
  | TestDefPayload
  | ParseErrorPayload;

export interface Fact {
  readonly kind: FactKind;
  readonly resolved: boolean;
  readonly location: FactLocation;
  readonly anchors: readonly FactAnchorRef[];
  readonly payload: FactPayload;
}
