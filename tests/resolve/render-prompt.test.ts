import { describe, it, expect } from 'vitest';
import { WORKED_EXAMPLE, renderPrompt } from '../../src/resolve/render-prompt.js';
import { parseResolutionsFile } from '../../src/resolve/parse.js';
import type { ResolveUnit } from '../../src/resolve/types.js';
import type { ProjectRelativePath } from '../../src/types.js';

describe('render-prompt — drift guard', () => {
  it('WORKED_EXAMPLE parses cleanly through the real ResolutionsFile parser', () => {
    const r = parseResolutionsFile(WORKED_EXAMPLE);
    expect(r.kind).toBe('ok');
  });

  it('WORKED_EXAMPLE demonstrates both parser arms', () => {
    const classes = WORKED_EXAMPLE.resolutions.map((x) => x.classification);
    expect(classes).toContain('structural-rule');
    expect(classes).toContain('data-dependent-unresolvable');
  });
});

function unit(over: Partial<ResolveUnit> = {}): ResolveUnit {
  return {
    exprHash: 'HASH1',
    factKind: 'hook-fire',
    unresolvedExpression: '$hook',
    enclosingScope: '(file)',
    filePath: 'inc.php' as ProjectRelativePath,
    codeContext: { startLine: 10, endLine: 12, text: 'a\nb\nc' },
    ...over,
  };
}

describe('renderPrompt', () => {
  it('contains the task, citation rule, and the three classifications', () => {
    const out = renderPrompt([unit()], { project: '/p', chunkIndex: 1, chunkCount: 1 });
    expect(out).toContain('hook name');
    expect(out).toMatch(/cite/i);
    expect(out).toContain('structural-rule');
    expect(out).toContain('project-constant');
    expect(out).toContain('data-dependent-unresolvable');
  });

  it('embeds the worked example JSON verbatim', () => {
    const out = renderPrompt([unit()], { project: '/p', chunkIndex: 1, chunkCount: 1 });
    expect(out).toContain(JSON.stringify(WORKED_EXAMPLE, null, 2));
  });

  it('renders the batch header from chunk indices', () => {
    const out = renderPrompt([unit()], { project: '/p', chunkIndex: 2, chunkCount: 9 });
    expect(out).toContain('batch 2 of 9');
  });

  it('embeds each unit with a line-numbered code gutter', () => {
    const out = renderPrompt(
      [unit({ exprHash: 'ZZZ', codeContext: { startLine: 10, endLine: 12, text: 'a\nb\nc' } })],
      { project: '/p', chunkIndex: 1, chunkCount: 1 },
    );
    expect(out).toContain('ZZZ');
    expect(out).toContain('$hook');
    expect(out).toContain('(file)');
    expect(out).toContain('inc.php');
    expect(out).toContain('10 |');
    expect(out).toContain('11 |');
    expect(out).toContain('12 |');
  });
});
