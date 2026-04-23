import type { TestsQueryResult, QueryTestEdge } from '../query/types.js';

// POSIX single-quote escape: the only thing that can't appear inside '...' is
// a literal ', so we end the quoted section, insert a "'" via double quotes,
// and start a new quoted section: foo's bar → 'foo'"'"'s bar'.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function emitOne(edge: QueryTestEdge): string {
  switch (edge.framework) {
    case 'phpunit':
      return edge.filter === undefined
        ? edge.file
        : `${edge.file} --filter ${shellSingleQuote(`^${edge.filter}$`)}`;
    case 'jest':
      return edge.filter === undefined
        ? edge.file
        : `${edge.file} -t ${shellSingleQuote(edge.filter)}`;
    case 'playwright':
      return edge.filter === undefined
        ? edge.file
        : `${edge.file} --grep ${shellSingleQuote(edge.filter)}`;
  }
}

export function formatArgs(result: TestsQueryResult): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const edge of result.tests) {
    const line = emitOne(edge);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  lines.sort();
  return lines.join('\n');
}
