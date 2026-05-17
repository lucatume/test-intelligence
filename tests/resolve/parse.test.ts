import { describe, it, expect } from 'vitest';
import { parseResolveBundle, parseResolutionsFile } from '../../src/resolve/parse.js';

describe('parseResolutionsFile — the hallucination guard', () => {
  it('rejects a structural-rule resolution missing citation', () => {
    const r = parseResolutionsFile({
      version: 1, pass: 'llm',
      resolutions: [{ exprHash: 'h', classification: 'structural-rule',
        resolvedValue: { hookName: 'x' } }],
    });
    expect(r.kind).toBe('err');
  });

  it('rejects a structural-rule resolution missing resolvedValue', () => {
    const r = parseResolutionsFile({
      version: 1, pass: 'llm',
      resolutions: [{ exprHash: 'h', classification: 'structural-rule',
        citation: { path: 'a.php', line: 5 } }],
    });
    expect(r.kind).toBe('err');
  });

  it('rejects a data-dependent-unresolvable resolution carrying a resolvedValue', () => {
    const r = parseResolutionsFile({
      version: 1, pass: 'llm',
      resolutions: [{ exprHash: 'h', classification: 'data-dependent-unresolvable',
        resolvedValue: { hookName: 'x' } }],
    });
    expect(r.kind).toBe('err');
  });

  it('accepts a data-dependent-unresolvable resolution with neither', () => {
    const r = parseResolutionsFile({
      version: 1, pass: 'llm',
      resolutions: [{ exprHash: 'h', classification: 'data-dependent-unresolvable' }],
    });
    expect(r.kind).toBe('ok');
  });

  it('accepts a well-formed structural-rule resolution', () => {
    const r = parseResolutionsFile({
      version: 1, pass: 'llm',
      resolutions: [{ exprHash: 'h', classification: 'structural-rule',
        resolvedValue: { hookName: 'save_post' },
        citation: { path: 'a.php', line: 5 } }],
    });
    expect(r.kind).toBe('ok');
  });

  it('rejects a wrong version', () => {
    const r = parseResolutionsFile({ version: 2, pass: 'llm', resolutions: [] });
    expect(r.kind).toBe('err');
  });

  it('rejects an unknown classification', () => {
    const r = parseResolutionsFile({
      version: 1, pass: 'llm',
      resolutions: [{ exprHash: 'h', classification: 'made-up' }],
    });
    expect(r.kind).toBe('err');
  });

  it('rejects an absolute citation path', () => {
    const r = parseResolutionsFile({
      version: 1, pass: 'llm',
      resolutions: [{ exprHash: 'h', classification: 'structural-rule',
        resolvedValue: { hookName: 'x' },
        citation: { path: '/etc/passwd', line: 1 } }],
    });
    expect(r.kind).toBe('err');
  });
});

describe('parseResolveBundle', () => {
  it('rejects an unknown factKind', () => {
    const r = parseResolveBundle({
      version: 1, pass: 'llm', project: '/p', generatedAt: '2026-05-17T00:00:00.000Z',
      units: [{ exprHash: 'h', factKind: 'rest-call-js', unresolvedExpression: '$x',
        enclosingScope: 'f', filePath: 'a.php',
        codeContext: { startLine: 1, endLine: 2, text: '' } }],
    });
    expect(r.kind).toBe('err');
  });

  it('rejects a missing exprHash', () => {
    const r = parseResolveBundle({
      version: 1, pass: 'llm', project: '/p', generatedAt: '2026-05-17T00:00:00.000Z',
      units: [{ factKind: 'hook-fire', unresolvedExpression: '$x',
        enclosingScope: 'f', filePath: 'a.php',
        codeContext: { startLine: 1, endLine: 2, text: '' } }],
    });
    expect(r.kind).toBe('err');
  });

  it('accepts a well-formed bundle', () => {
    const r = parseResolveBundle({
      version: 1, pass: 'llm', project: '/p', generatedAt: '2026-05-17T00:00:00.000Z',
      units: [{ exprHash: 'h', factKind: 'hook-fire', unresolvedExpression: '$x',
        enclosingScope: 'f', filePath: 'a.php',
        codeContext: { startLine: 1, endLine: 2, text: 'do_action($x);' } }],
    });
    expect(r.kind).toBe('ok');
  });
});
