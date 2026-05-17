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

// Resolution context stamped on every fact emitted `resolved = 0`. One shared
// shape across all fact kinds — the cache key the LLM-resolution pass keys on.
export interface UnresolvedExpr {
  readonly field: string;
  readonly expression: string;
}

export interface UnresolvedBlock {
  readonly scope: string;
  readonly fields: readonly UnresolvedExpr[];
  readonly exprHash: string;
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
  readonly unresolved?: UnresolvedBlock;
}

export interface PhpIncludePayload {
  readonly kind: 'php-include';
  readonly target: string;
  readonly unresolved?: UnresolvedBlock;
}

export interface HookListenerPayload {
  readonly kind: 'hook-listener';
  readonly hook: string;
  readonly priority?: number;
  readonly callback?: string;
  readonly unresolved?: UnresolvedBlock;
}

export interface HookFirePayload {
  readonly kind: 'hook-fire';
  readonly hook: string;
  readonly unresolved?: UnresolvedBlock;
}

export interface RestEndpointPayload {
  readonly kind: 'rest-endpoint';
  readonly method: string;
  readonly route: string;
  readonly callback?: string;
  /** Set true when the route carried a normalized regex param (`(?P<id>…)` → `{*}`). */
  readonly routeParam?: boolean;
  /** Present on facts left `resolved = 0` — the shared partial-fact resolution
   *  context (enclosing scope, per-field unresolved expressions, stable hash). */
  readonly unresolved?: UnresolvedBlock;
}

export interface RestCallJsPayload {
  readonly kind: 'rest-call-js';
  readonly method: string;
  readonly route: string;
  readonly unresolved?: UnresolvedBlock;
}

export interface AjaxListenerPayload {
  readonly kind: 'ajax-listener';
  readonly action: string;
  readonly callback?: string;
}

export interface AjaxCallJsPayload {
  readonly kind: 'ajax-call-js';
  readonly action: string;
  readonly unresolved?: UnresolvedBlock;
}

export interface EnqueueScriptPayload {
  readonly kind: 'enqueue-script';
  readonly handle: string;
  readonly src?: string;
  readonly resolvedJsModule?: string;
  readonly unresolved?: UnresolvedBlock;
}

export interface AdminPageNavPayload {
  readonly kind: 'admin-page-nav';
  readonly url: string;
  readonly slug: string;
  readonly method: 'goto' | 'route';
  readonly unresolved?: UnresolvedBlock;
}

export interface AdminPageRegisterPayload {
  readonly kind: 'admin-page-register';
  readonly slug: string;
  readonly fn: 'add_menu_page' | 'add_submenu_page';
  readonly unresolved?: UnresolvedBlock;
}

export interface StoreRegisterPayload {
  readonly kind: 'store-register';
  readonly key: string;
}

export interface StoreAccessPayload {
  readonly kind: 'store-access';
  readonly key: string;
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
  readonly unresolved?: UnresolvedBlock;
}

export interface BlockRenderPayload {
  readonly kind: 'block-render';
  readonly name: string;
  readonly callback?: string;
  readonly unresolved?: UnresolvedBlock;
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
  | StoreRegisterPayload
  | StoreAccessPayload
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
