import type { AnchorKey } from '../types.js';
import type { FactRow, FileRow, Graph } from './types.js';

export interface WildcardAnchorEntry {
  readonly regex: RegExp;
  readonly originalKey: AnchorKey;
  readonly facts: readonly FactRow[];
}

export interface AnchorIndex {
  readonly subjectsByAnchor: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  readonly targetsByAnchor: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  readonly modulesByAnchor: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  readonly callbacksByAnchor: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  readonly linksByFact: ReadonlyMap<number, readonly { anchorKey: AnchorKey; role: 'subject' | 'target' | 'module' | 'callback' }[]>;
  // Per-path lookup so traverse can resolve `import-edge` / `php-include`
  // target paths in O(1) instead of scanning `graph.files.values()`.
  readonly filesByPath: ReadonlyMap<string, FileRow>;
  readonly wildcardSubjects: readonly WildcardAnchorEntry[];
  readonly wildcardTargets: readonly WildcardAnchorEntry[];
  readonly wildcardModules: readonly WildcardAnchorEntry[];
  readonly wildcardCallbacks: readonly WildcardAnchorEntry[];
}

const WILDCARD_TOKEN = '{*}';

function isWildcardKey(key: AnchorKey): boolean {
  return key.includes(WILDCARD_TOKEN);
}

export function wildcardKeyToRegex(key: AnchorKey): RegExp {
  // Escape regex specials, then translate `{*}` (which becomes `\{\*\}` after
  // escape) into `[^\s]+` (one or more non-whitespace chars, greedy).
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\\\{\\\*\\\}/g, '[^\\s]+');
  return new RegExp('^' + pattern + '$');
}

export function buildAnchorIndex(graph: Graph): AnchorIndex {
  const subjects = new Map<AnchorKey, FactRow[]>();
  const targets = new Map<AnchorKey, FactRow[]>();
  const modules = new Map<AnchorKey, FactRow[]>();
  const callbacks = new Map<AnchorKey, FactRow[]>();
  const linksByFact = new Map<number, Array<{ anchorKey: AnchorKey; role: 'subject' | 'target' | 'module' | 'callback' }>>();
  const filesByPath = new Map<string, FileRow>();

  const wildBuckets = {
    subject: new Map<AnchorKey, FactRow[]>(),
    target: new Map<AnchorKey, FactRow[]>(),
    module: new Map<AnchorKey, FactRow[]>(),
    callback: new Map<AnchorKey, FactRow[]>(),
  };

  for (const file of graph.files.values()) filesByPath.set(file.path, file);

  for (const link of graph.anchorLinks) {
    const fact = graph.facts.get(link.factId);
    if (!fact) continue;

    if (isWildcardKey(link.anchorKey)) {
      const wb = wildBuckets[link.role];
      const existing = wb.get(link.anchorKey);
      if (existing) existing.push(fact);
      else wb.set(link.anchorKey, [fact]);
    } else {
      const bucket =
        link.role === 'subject' ? subjects :
        link.role === 'target' ? targets :
        link.role === 'module' ? modules :
        callbacks;
      const existing = bucket.get(link.anchorKey);
      if (existing) existing.push(fact);
      else bucket.set(link.anchorKey, [fact]);
    }

    let linkList = linksByFact.get(link.factId);
    if (!linkList) {
      linkList = [];
      linksByFact.set(link.factId, linkList);
    }
    linkList.push({ anchorKey: link.anchorKey, role: link.role });
  }

  const bucketToEntries = (b: Map<AnchorKey, FactRow[]>): WildcardAnchorEntry[] => {
    const out: WildcardAnchorEntry[] = [];
    for (const [key, facts] of b) {
      out.push({ regex: wildcardKeyToRegex(key), originalKey: key, facts });
    }
    return out;
  };

  return {
    subjectsByAnchor: subjects,
    targetsByAnchor: targets,
    modulesByAnchor: modules,
    callbacksByAnchor: callbacks,
    linksByFact,
    filesByPath,
    wildcardSubjects: bucketToEntries(wildBuckets.subject),
    wildcardTargets: bucketToEntries(wildBuckets.target),
    wildcardModules: bucketToEntries(wildBuckets.module),
    wildcardCallbacks: bucketToEntries(wildBuckets.callback),
  };
}
