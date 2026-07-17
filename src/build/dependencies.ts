import type Database from 'better-sqlite3';
import type { ValidatedConfig } from '../config/parse.js';
import { HOOK_STOP_LIST_BUILTINS } from '../config/parse.js';
import { buildAnchorIndex } from '../derive/anchor-index.js';
import { loadGraph } from '../derive/load.js';
import { directDependenciesFromSources } from '../derive/traverse.js';
import type { DependencyEdge } from '../derive/types.js';

export interface SourceDependencyResult {
  readonly rows: readonly DependencyEdge[];
  readonly unknownPaths: readonly string[];
}

export function sourceDependencies(
  db: Database.Database,
  config: ValidatedConfig,
  sources: readonly string[],
  minConfidence: number,
): SourceDependencyResult {
  const stopList = new Set(HOOK_STOP_LIST_BUILTINS);
  for (const hook of config.hooks.stopList.add) stopList.add(hook);
  for (const hook of config.hooks.stopList.remove) stopList.delete(hook);
  const graph = loadGraph(db);
  return directDependenciesFromSources(graph, buildAnchorIndex(graph), sources, {
    maxDepth: 1,
    maxMillisPerTest: config.traversal.maxMillisPerTest,
    threshold: minConfidence,
    hookStopList: stopList,
    now: () => 0,
    maxWildcardMatchesPerAnchor: config.traversal.maxWildcardMatchesPerAnchor,
  });
}
