import type { AnchorKey, AnchorType } from '../types.js';

export interface RestAnchor {
  readonly key: AnchorKey;
  readonly type: 'rest';
  readonly method: string;
  readonly route: string;
  readonly partial: boolean;
}

export interface SimpleAnchor {
  readonly key: AnchorKey;
  readonly type: Exclude<AnchorType, 'rest'>;
  readonly body: string;
  readonly partial?: boolean;
}

export type Anchor = RestAnchor | SimpleAnchor;

export interface AnchorParseError {
  readonly kind: 'AnchorParseError';
  readonly raw: string;
  readonly reason: string;
}
