import type { AnchorKey } from '../types.js';
import type { FactRow, FileRow, Graph } from './types.js';

export interface AnchorIndex {
  readonly subjectsByAnchor: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  readonly targetsByAnchor: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  readonly modulesByAnchor: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  readonly callbacksByAnchor: ReadonlyMap<AnchorKey, readonly FactRow[]>;
  readonly linksByFact: ReadonlyMap<number, readonly { anchorKey: AnchorKey; role: 'subject' | 'target' | 'module' | 'callback' }[]>;
  // Per-path lookup so traverse can resolve `import-edge` / `php-include`
  // target paths in O(1) instead of scanning `graph.files.values()`.
  readonly filesByPath: ReadonlyMap<string, FileRow>;
}

export function buildAnchorIndex(graph: Graph): AnchorIndex {
  const subjects = new Map<AnchorKey, FactRow[]>();
  const targets = new Map<AnchorKey, FactRow[]>();
  const modules = new Map<AnchorKey, FactRow[]>();
  const callbacks = new Map<AnchorKey, FactRow[]>();
  const linksByFact = new Map<number, Array<{ anchorKey: AnchorKey; role: 'subject' | 'target' | 'module' | 'callback' }>>();
  const filesByPath = new Map<string, FileRow>();

  for (const file of graph.files.values()) filesByPath.set(file.path, file);

  for (const link of graph.anchorLinks) {
    const fact = graph.facts.get(link.factId);
    if (!fact) continue;
    const bucket =
      link.role === 'subject' ? subjects :
      link.role === 'target' ? targets :
      link.role === 'module' ? modules :
      callbacks;
    const existing = bucket.get(link.anchorKey);
    if (existing) existing.push(fact);
    else bucket.set(link.anchorKey, [fact]);

    let linkList = linksByFact.get(link.factId);
    if (!linkList) {
      linkList = [];
      linksByFact.set(link.factId, linkList);
    }
    linkList.push({ anchorKey: link.anchorKey, role: link.role });
  }

  return {
    subjectsByAnchor: subjects,
    targetsByAnchor: targets,
    modulesByAnchor: modules,
    callbacksByAnchor: callbacks,
    linksByFact,
    filesByPath,
  };
}
