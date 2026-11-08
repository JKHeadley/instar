/** A local OS/SQLite exception must pass through operatorError before an HTTP error can expose it. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function unqualified(text: string): number[] {
  const source = ts.createSourceFile('route.ts', text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  function walk(node: ts.Node, caught?: string): void {
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) caught = node.variableDeclaration.name.text;
    const body = ts.isReturnStatement(node) ? node.expression :
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined;
    const responseArgs = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'json' ? [...node.arguments] :
      body && ts.isObjectLiteralExpression(body) && body.properties.some(p => p.name?.getText(source) === 'body') ? [body] : null;
    if (caught && responseArgs) {
      const scan = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'operatorError') return;
        if ((ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === caught && n.name.text === 'message') ||
            (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'String' && n.arguments.some(a => ts.isIdentifier(a) && a.text === caught))) {
          lines.push(source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1);
        }
        ts.forEachChild(n, scan);
      };
      responseArgs.forEach(scan);
      return;
    }
    ts.forEachChild(node, n => walk(n, caught));
  }
  walk(source);
  return lines;
}

describe('local storage error response ratchet', () => {
  it('detects both raw Error messages and thrown strings and accepts qualified responses', () => {
    expect(unqualified('try {} catch (err) { res.status(500).json({ error: err.message }); }')).toHaveLength(1);
    expect(unqualified('try {} catch (err) { res.status(500).json({ error: String(err) }); }')).toHaveLength(1);
    expect(unqualified('try {} catch (err) { res.status(500).json({ error: operatorError(err, stateDir) }); }')).toEqual([]);
    expect(unqualified('try {} catch (err) { return { status: 500, body: { error: err.message } }; }')).toHaveLength(1);
    expect(unqualified('try {} catch (err) { result = { status: 500, body: { error: err.message } }; }')).toHaveLength(1);
    expect(unqualified('try {} catch (err) { result = { status: 500, body: { error: operatorError(err, stateDir) } }; }')).toEqual([]);
    expect(unqualified('try {} catch (err) { console.warn(err.message); result = { status: 500, body: safeBody }; }')).toEqual([]);
    // A peer response is already qualified at its origin; never substitute the receiving host.
    expect(unqualified('try {} catch (err) { res.status(500).json(peerResponse); }')).toEqual([]);
  });

  it('every direct caught-exception JSON response in the server uses the qualifier', () => {
    const dir = path.resolve('src/server');
    const violations = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).flatMap(file =>
      unqualified(fs.readFileSync(path.join(dir, file), 'utf8')).map(line => `${file}:${line}`));
    expect(violations).toEqual([]);
  });
});
