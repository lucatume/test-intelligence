import type { AnchorKey, FactKind, FrameworkName } from '../types.js';
import type { AnchorRole } from '../facts/types.js';

export interface FileRow {
  readonly id: number;
  readonly path: string;
  readonly language: string;
  readonly vendor: boolean;
  readonly framework: FrameworkName | null;
  readonly frameworkClass: 'unit' | 'e2e' | null;
}

export interface FactRow {
  readonly id: number;
  readonly fileId: number;
  readonly kind: FactKind;
  readonly resolved: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface FactAnchorLink {
  readonly factId: number;
  readonly anchorKey: AnchorKey;
  readonly role: AnchorRole;
}

export interface TestRow {
  readonly testId: string;
  readonly fileId: number;
  readonly framework: FrameworkName;
  readonly frameworkClass: 'unit' | 'e2e';
  readonly factId: number;
}

export interface Graph {
  readonly files: ReadonlyMap<number, FileRow>;
  readonly facts: ReadonlyMap<number, FactRow>;
  readonly factsByFile: ReadonlyMap<number, readonly FactRow[]>;
  readonly anchorLinks: readonly FactAnchorLink[];
  readonly tests: readonly TestRow[];
}

export type EdgeKind =
  | 'symbol-call'
  | 'symbol-call-uncertain'
  | 'php-include'
  | 'js-import'
  | 'hook-mediated'
  | 'hook-mediated-uncertain'
  | 'rest-mediated'
  | 'rest-mediated-partial'
  | 'ajax-mediated'
  | 'ajax-mediated-partial'
  | 'enqueue-mediated'
  | 'admin-page-mediated'
  | 'shortcode-render'
  | 'block-render'
  | 'store-mediated';

export interface Edge {
  readonly testId: string;
  readonly source: string;
  readonly confidence: number;
  readonly partial: boolean;
  readonly evidence: ReadonlyArray<{ kind: EdgeKind; factIds: readonly number[] }>;
}
