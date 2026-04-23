import type {
  TestsQueryResult,
  SourcesQueryResult,
  ExplainResult,
} from '../query/types.js';

export function formatTestsJson(r: TestsQueryResult): string {
  return JSON.stringify({
    framework: r.framework,
    tests: r.tests.map((t) => ({
      id: t.id,
      file: t.file,
      framework: t.framework,
      filter: t.filter ?? null,
      granularity: t.granularity,
      confidence: t.confidence,
      stale: t.stale,
      strategies: t.strategies,
    })),
    unknownInputs: r.unknownInputs,
  }, null, 2);
}

export function formatSourcesJson(r: SourcesQueryResult): string {
  return JSON.stringify({
    sources: r.sources,
    unknownInputs: r.unknownInputs,
  }, null, 2);
}

export function formatSourcesArgs(r: SourcesQueryResult): string {
  return r.sources.join('\n');
}

export function formatExplainJson(r: ExplainResult): string {
  return JSON.stringify(r, null, 2);
}

// Human-oriented explain output: a compact single-line summary per edge.
// Used when `ti explain` is invoked without --format (spec defaults to 'args'
// for tests/sources but explain is stdout-human by default).
export function formatExplainHuman(r: ExplainResult): string {
  if (r.kind === 'unknown') return `unknown id or path: ${r.target}`;
  if (r.kind === 'test') {
    const e = r.edge;
    const strats = e.strategies.join(', ') || 'none';
    const stale = e.stale ? ' (stale)' : '';
    const covers = e.coveredSources.length === 0 ? '' : `\n  covered sources: ${e.coveredSources.join(', ')}`;
    return `${e.id}  confidence=${e.confidence.toFixed(2)}  strategies=${strats}${stale}${covers}`;
  }
  // kind === 'source'
  const lines = [`source: ${r.source}`];
  for (const t of r.tests) {
    const strats = t.strategies.join(', ') || 'none';
    const stale = t.stale ? ' (stale)' : '';
    lines.push(`  ${t.id}  confidence=${t.confidence.toFixed(2)}  strategies=${strats}${stale}`);
  }
  return lines.join('\n');
}
