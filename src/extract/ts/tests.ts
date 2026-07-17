import ts from 'typescript';
import type { Fact, FactLocation, TestDefPayload } from '../../facts/types.js';
import type { AnchorKey, FrameworkName } from '../../types.js';

const TEST_NAMES = new Set(['it', 'test']);
const DESCRIBE_NAMES = new Set(['describe']);

export function extractTestDefs(
  sf: ts.SourceFile,
  relPath: string,
  framework: FrameworkName | null,
): Fact[] {
  if (framework === null || framework === 'phpunit') return [];
  const out: Fact[] = [];

  const emitFact = (call: ts.CallExpression, scope: readonly string[]): void => {
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
    const processStatements = (statements: readonly ts.Statement[], inherited: readonly string[]): void => {
      let scope = [...inherited];
      for (const statement of statements) {
        if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
          const call = statement.expression;
          const name = getQUnitName(call);
          if (name === 'module') {
            const title = getTitle(call) ?? '<dynamic>';
            const cb = call.arguments[1];
            if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && ts.isBlock(cb.body)) {
              processStatements(cb.body.statements, [...inherited, title]);
            } else {
              scope = [...inherited, title];
            }
            continue;
          }
          if (name === 'test') {
            emitFact(call, scope);
            continue;
          }
        }
        const visitNested = (node: ts.Node): void => {
          if (ts.isBlock(node)) {
            processStatements(node.statements, scope);
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

  const walk = (node: ts.Node, scope: readonly string[]): void => {
    ts.forEachChild(node, (child) => {
      if (ts.isCallExpression(child)) {
        const name = getCalleeName(child);
        if (name !== null && DESCRIBE_NAMES.has(name)) {
          const title = getTitle(child);
          const nextScope = title === null ? [...scope, '<dynamic>'] : [...scope, title];
          const cb = child.arguments[1];
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
            walk(cb.body, nextScope);
          }
          return;
        }
        if (name !== null && TEST_NAMES.has(name)) {
          emitFact(child, scope);
          return;
        }
      }
      walk(child, scope);
    });
  };
  walk(sf, []);
  return out;
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
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)) {
    return call.expression.expression.text;
  }
  return null;
}

function getTitle(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (arg && ts.isStringLiteral(arg)) return arg.text;
  if (arg && ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null;
}
