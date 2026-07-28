import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'use']);
const responseMethods = new Set(['json', 'send', 'sendStatus', 'redirect', 'download', 'sendFile']);

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

function isRouteRegistration(node: ts.CallExpression): boolean {
  const expr = node.expression;
  return ts.isPropertyAccessExpression(expr) && routeMethods.has(expr.name.text);
}

function isResponseSend(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr) || !responseMethods.has(expr.name.text)) return false;

  let base: ts.Expression = expr.expression;
  while (ts.isCallExpression(base) || ts.isPropertyAccessExpression(base)) {
    base = ts.isCallExpression(base) ? base.expression : base.expression;
  }
  return ts.isIdentifier(base) && base.text === 'res';
}

function nodeHasResponseSend(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (isResponseSend(child)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function statementHasDirectResponseSend(statement: ts.Statement): boolean {
  if (ts.isExpressionStatement(statement)) return nodeHasResponseSend(statement.expression);
  if (ts.isReturnStatement(statement) && statement.expression) return nodeHasResponseSend(statement.expression);
  return false;
}

function statementIsTerminal(statement: ts.Statement): boolean {
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
}

function branchSendsWithoutReturn(statement: ts.Statement): boolean {
  const statements = ts.isBlock(statement) ? [...statement.statements] : [statement];
  for (let index = 0; index < statements.length; index += 1) {
    const current = statements[index];
    if (statementIsTerminal(current)) continue;
    if (!statementHasDirectResponseSend(current)) continue;
    return !statements.slice(index + 1).some(statementIsTerminal);
  }
  return false;
}

function laterStatementsSend(statements: readonly ts.Statement[], index: number): boolean {
  for (const later of statements.slice(index + 1)) {
    if (statementIsTerminal(later)) return false;
    if (statementHasDirectResponseSend(later)) return true;
  }
  return false;
}

function findMissingReturnDoubleSends(sourceText: string, file: string): Finding[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];

  const inspectHandler = (handler: ts.Node): void => {
    if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
    if (!ts.isBlock(handler.body)) return;

    const statements = [...handler.body.statements];
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      if (!ts.isIfStatement(statement)) continue;
      const unsafeBranch =
        branchSendsWithoutReturn(statement.thenStatement)
        || (statement.elseStatement ? branchSendsWithoutReturn(statement.elseStatement) : false);
      if (!unsafeBranch || !laterStatementsSend(statements, index)) continue;

      const pos = source.getLineAndCharacterOfPosition(statement.getStart(source));
      findings.push({
        file,
        line: pos.line + 1,
        snippet: statement.getText(source).split('\n').slice(0, 6).join('\n'),
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRouteRegistration(node)) {
      for (const arg of node.arguments) inspectHandler(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return findings;
}

function sourceFiles(): string[] {
  const roots = ['src/server', 'src/moltbridge', 'src/messaging/backends'];
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && fullPath.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  };
  for (const root of roots) walk(root);
  return files.sort();
}

describe('route double-send source audit', () => {
  it('detects the missing-return early-response shape', () => {
    const fixture = `
      router.get('/bad', (req, res) => {
        if (!req.query.id) {
          res.status(400).json({ error: 'id required' });
        }
        res.json({ ok: true });
      });
    `;

    expect(findMissingReturnDoubleSends(fixture, 'fixture.ts')).toHaveLength(1);
  });

  it('keeps src/server route handlers free of missing-return double sends', () => {
    const findings = sourceFiles().flatMap((file) =>
      findMissingReturnDoubleSends(fs.readFileSync(path.resolve(file), 'utf8'), file)
    );

    expect(findings).toEqual([]);
  });
});
