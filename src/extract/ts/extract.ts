import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import type { Fact, FactLocation } from '../../facts/types.js';
import type { FrameworkName, Language } from '../../types.js';
import type { UserPattern } from '../declarative/pattern.js';
import { extractImports } from './imports.js';
import { extractSymbols } from './symbols.js';
import { extractTestDefs } from './tests.js';
import { runDeclarativePatterns } from '../declarative/engine.js';

export interface ExtractTsInput {
  readonly projectRoot: string;
  readonly relPath: string;
  readonly language: Language;
  readonly framework: FrameworkName | null;
  readonly compilerOptions: ts.CompilerOptions;
  readonly patterns: readonly UserPattern[];
  readonly source?: string;
}

export async function extractTsFile(input: ExtractTsInput): Promise<Fact[]> {
  const absPath = join(input.projectRoot, input.relPath);
  const text =
    input.source !== undefined
      ? input.source
      : await readFile(absPath, 'utf8');
  const scriptKind = scriptKindFor(input.language);
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, scriptKind);

  const facts: Fact[] = [];
  facts.push(...extractImports(sf, input.relPath, input.projectRoot, input.compilerOptions));
  facts.push(...extractSymbols(sf, input.relPath));
  facts.push(...extractTestDefs(sf, input.relPath, input.framework));
  facts.push(...runDeclarativePatterns(sf, input.relPath, input.patterns));

  const diags = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const first = diags[0];
  if (first !== undefined) {
    const line =
      typeof first.start === 'number'
        ? sf.getLineAndCharacterOfPosition(first.start).line + 1
        : 1;
    const location: FactLocation = {
      file: input.relPath as FactLocation['file'],
      startLine: line,
      endLine: line,
    };
    facts.push({
      kind: 'parse-error',
      resolved: false,
      location,
      anchors: [],
      payload: {
        kind: 'parse-error',
        message: typeof first.messageText === 'string' ? first.messageText : ts.flattenDiagnosticMessageText(first.messageText, '\n'),
        line,
      },
    });
  }
  return facts;
}

function scriptKindFor(lang: Language): ts.ScriptKind {
  switch (lang) {
    case 'ts': return ts.ScriptKind.TS;
    case 'tsx': return ts.ScriptKind.TSX;
    case 'jsx': return ts.ScriptKind.JSX;
    case 'js': return ts.ScriptKind.JS;
    case 'mjs': return ts.ScriptKind.JS;
    case 'cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.Unknown;
  }
}
