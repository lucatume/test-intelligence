import ts from 'typescript';
import type { Fact, FactLocation, TestDefPayload } from '../../facts/types.js';
import type { AnchorKey, FrameworkName } from '../../types.js';

const TEST_NAMES = new Set(['it', 'test']);
const DESCRIBE_NAMES = new Set(['describe']);
const TEST_MODIFIERS = new Set([
  'concurrent', 'fail', 'failing', 'fixme', 'only', 'skip', 'slow', 'todo',
]);
const DESCRIBE_MODIFIERS = new Set(['only', 'parallel', 'serial', 'skip']);

interface ScopeRange {
  readonly startLine: number;
  readonly endLine: number;
}

export function extractTestDefs(
  sf: ts.SourceFile,
  relPath: string,
  framework: FrameworkName | null,
): Fact[] {
  if (framework === null || framework === 'phpunit') return [];
  const out: Fact[] = [];

  const emitFact = (
    call: ts.CallExpression,
    scope: readonly string[],
    scopeRanges: readonly ScopeRange[] = [],
  ): void => {
    const title = getTitle(call);
    const resolved = title !== null;
    const titleStr = title ?? '<dynamic>';
    const idSuffix = scope.length === 0 ? titleStr : `${scope.join(' > ')} > ${titleStr}`;
    const testId = `${framework}:${relPath}::${idSuffix}`;
    const start = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(call.getEnd()).line + 1;
    const payload: TestDefPayload = {
      kind: 'test-def',
      framework,
      testId,
      ...(title !== null ? { title } : {}),
      ...(scopeRanges.length > 0 ? { meta: { scopeRanges } } : {}),
    };
    const location: FactLocation = {
      file: relPath as FactLocation['file'],
      startLine: start,
      endLine: end,
    };
    out.push({
      kind: 'test-def',
      resolved,
      location,
      anchors: [{ key: `test:${testId}` as AnchorKey, role: 'subject' }],
      payload,
    });
  };

  if (framework === 'qunit') {
    const processStatements = (
      statements: readonly ts.Statement[],
      inherited: readonly string[],
      inheritedRanges: readonly ScopeRange[] = [],
    ): void => {
      let scope = [...inherited];
      for (const statement of statements) {
        if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
          const call = statement.expression;
          const name = getQUnitName(call);
          if (name === 'module') {
            const title = getTitle(call) ?? '<dynamic>';
            const cb = call.arguments[1];
            if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && ts.isBlock(cb.body)) {
              processStatements(cb.body.statements, [...inherited, title], [...inheritedRanges, lineRange(sf, call)]);
            } else {
              scope = [...inherited, title];
            }
            continue;
          }
          if (name === 'test') {
            emitFact(call, scope, inheritedRanges);
            continue;
          }
        }
        const visitNested = (node: ts.Node): void => {
          if (ts.isBlock(node)) {
            processStatements(node.statements, scope, inheritedRanges);
            return;
          }
          ts.forEachChild(node, visitNested);
        };
        ts.forEachChild(statement, visitNested);
      }
    };
    processStatements(sf.statements, []);
    return out;
  }

  const walk = (
    node: ts.Node,
    scope: readonly string[],
    scopeRanges: readonly ScopeRange[] = [],
  ): void => {
    ts.forEachChild(node, (child) => {
      if (ts.isCallExpression(child)) {
        const name = getCalleeName(child);
        if (name !== null && DESCRIBE_NAMES.has(name)) {
          const title = getTitle(child);
          const nextScope = title === null ? [...scope, '<dynamic>'] : [...scope, title];
          const cb = child.arguments[1];
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
            walk(cb.body, nextScope, [...scopeRanges, lineRange(sf, child)]);
          }
          return;
        }
        if (name !== null && TEST_NAMES.has(name)) {
          emitFact(child, scope, scopeRanges);
          return;
        }
      }
      walk(child, scope, scopeRanges);
    });
  };
  walk(sf, []);
  return out;
}

function lineRange(sf: ts.SourceFile, node: ts.Node): ScopeRange {
  return {
    startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  };
}

function getQUnitName(call: ts.CallExpression): 'module' | 'test' | null {
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'QUnit'
  ) {
    const name = call.expression.name.text;
    return name === 'module' || name === 'test' ? name : null;
  }
  return null;
}

function getCalleeName(call: ts.CallExpression): string | null {
  const chain = calleeChain(call.expression);
  if (chain === null) return null;
  const [root, ...members] = chain;
  if (root === 'describe') {
    return members.every((member) => DESCRIBE_MODIFIERS.has(member)) ? 'describe' : null;
  }
  if (root !== 'test' && root !== 'it') return null;
  if (members[0] === 'describe') {
    return members.slice(1).every((member) => DESCRIBE_MODIFIERS.has(member))
      ? 'describe'
      : null;
  }
  if (members.every((member) => TEST_MODIFIERS.has(member))) return root;
  return null;
}

function calleeChain(expression: ts.Expression): readonly string[] | null {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (!ts.isPropertyAccessExpression(expression)) return null;
  const parent = calleeChain(expression.expression);
  return parent === null ? null : [...parent, expression.name.text];
}

function getTitle(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (arg && ts.isStringLiteral(arg)) return arg.text;
  if (arg && ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null;
}
