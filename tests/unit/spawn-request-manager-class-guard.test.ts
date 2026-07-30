import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const managerPath = path.join(repoRoot, 'src/messaging/SpawnRequestManager.ts');
const serverPath = path.join(repoRoot, 'src/commands/server.ts');

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!('name' in node) || !node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return node.name.getText();
}

function callTarget(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  return node.expression.getText(sourceFile);
}

function guardedReturnViolations(
  guardedEvaluate: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
): number[] {
  const violations: number[] = [];
  const inspect = (node: ts.Node): void => {
    // A nested callback's return type is independent of #evaluateGuarded.
    if (node !== guardedEvaluate && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      const expression = node.expression;
      const validFunnelCall = expression
        && ts.isCallExpression(expression)
        && callTarget(expression, sourceFile) === 'this.#refuseTransiently';
      const validFinalObject = expression
        && ts.isObjectLiteralExpression(expression)
        && !expression.properties.some(ts.isSpreadAssignment)
        && expression.properties.some((property) =>
          ts.isPropertyAssignment(property)
          && propertyName(property) === 'approved'
          && (
            property.initializer.kind === ts.SyntaxKind.TrueKeyword
            || property.initializer.kind === ts.SyntaxKind.FalseKeyword
          ));
      if (!validFunnelCall && !validFinalObject) {
        violations.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(guardedEvaluate);
  return violations;
}

describe('SpawnRequestManager transient-refusal class guard', () => {
  it('funnels every retryable refusal through payload preservation and wires that guarded class in production', () => {
    const managerSource = fs.readFileSync(managerPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      managerPath,
      managerSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const managerClass = sourceFile.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === 'SpawnRequestManager',
    );
    expect(managerClass).toBeDefined();

    const method = (name: string): ts.MethodDeclaration | undefined =>
      managerClass!.members.find(
        (member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === name,
      );
    const publicEvaluate = method('evaluate');
    const guardedEvaluate = method('#evaluateGuarded');
    const preservationFunnel = method('#refuseTransiently');
    expect(publicEvaluate).toBeDefined();
    expect(guardedEvaluate).toBeDefined();
    expect(preservationFunnel).toBeDefined();

    const publicReturns: ts.ReturnStatement[] = [];
    const collectPublicReturns = (node: ts.Node): void => {
      if (ts.isReturnStatement(node)) publicReturns.push(node);
      ts.forEachChild(node, collectPublicReturns);
    };
    collectPublicReturns(publicEvaluate!);
    expect(publicReturns).toHaveLength(1);
    expect(publicReturns[0].expression && ts.isCallExpression(publicReturns[0].expression)).toBe(true);
    expect(callTarget(publicReturns[0].expression as ts.CallExpression, sourceFile)).toBe('this.#evaluateGuarded');

    // TypeScript's private GuardedSpawnResult brand is the non-bypassable part:
    // a computed key, Object.assign, imported helper, or prebuilt SpawnResult
    // cannot satisfy #evaluateGuarded's return type. This AST assertion pins
    // the public method to that typed funnel and forbids type assertions inside
    // the guarded method that could cast around the compiler.
    const unsafeAssertions: number[] = [];
    const directRetryableObjects: number[] = [];
    const inspectGuarded = (node: ts.Node): void => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        unsafeAssertions.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
      if (
        ts.isObjectLiteralExpression(node)
        && node.properties.some((property) => propertyName(property) === 'retryAfterMs')
      ) {
        directRetryableObjects.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
      ts.forEachChild(node, inspectGuarded);
    };
    inspectGuarded(guardedEvaluate!);
    expect(unsafeAssertions).toEqual([]);
    expect(directRetryableObjects).toEqual([]);
    expect(guardedReturnViolations(guardedEvaluate!, sourceFile)).toEqual([]);

    // The only cast to either private guard type may be the factory's single
    // brand construction. A helper elsewhere cannot cast or widen itself into
    // a retryable result and then hide behind an indirect return call.
    const brandedCasts: Array<{ method: string | undefined; type: string }> = [];
    const inspectBrandedCasts = (node: ts.Node, method?: string): void => {
      const currentMethod = ts.isMethodDeclaration(node)
        ? node.name.getText(sourceFile)
        : method;
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const type = node.type.getText(sourceFile);
        if (type === 'PreservedTransientRefusal' || type === 'GuardedSpawnResult') {
          brandedCasts.push({ method: currentMethod, type });
        }
      }
      ts.forEachChild(node, (child) => inspectBrandedCasts(child, currentMethod));
    };
    inspectBrandedCasts(managerClass!);
    expect(brandedCasts).toEqual([
      { method: '#refuseTransiently', type: 'PreservedTransientRefusal' },
    ]);

    const serverSource = fs.readFileSync(serverPath, 'utf8');
    const serverFile = ts.createSourceFile(
      serverPath,
      serverSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let constructsManager = 0;
    let routesManager = 0;
    let startsManager = 0;
    let disposesManager = 0;
    let givesManagerToServer = 0;
    const inspectServer = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.left.getText(serverFile) === 'spawnManager'
        && ts.isNewExpression(node.right)
        && node.right.expression.getText(serverFile) === 'SpawnRequestManager'
      ) constructsManager++;
      if (
        ts.isNewExpression(node)
        && node.expression.getText(serverFile) === 'ThreadlineRouter'
        && node.arguments?.some((argument) => argument.getText(serverFile) === 'spawnManager')
      ) routesManager++;
      if (ts.isCallExpression(node) && callTarget(node, serverFile) === 'spawnManager.start') startsManager++;
      if (ts.isCallExpression(node) && callTarget(node, serverFile) === 'spawnManager.dispose') disposesManager++;
      if (
        ts.isNewExpression(node)
        && node.expression.getText(serverFile) === 'AgentServer'
        && node.arguments?.some((argument) =>
          ts.isObjectLiteralExpression(argument)
          && argument.properties.some((property) => propertyName(property) === 'spawnManager'))
      ) givesManagerToServer++;
      ts.forEachChild(node, inspectServer);
    };
    inspectServer(serverFile);
    expect(constructsManager).toBe(1);
    expect(routesManager).toBe(1);
    expect(startsManager).toBe(1);
    expect(disposesManager).toBe(1);
    expect(givesManagerToServer).toBe(1);
  });

  it('rejects retryable helper indirection outside the guarded method', () => {
    const managerSource = fs.readFileSync(managerPath, 'utf8');
    const mutatedSource = managerSource
      .replace(
        '  // ── Public API',
        `  #retryableBypass(): any {
    return { approved: false, retryAfterMs: 1 };
  }

  // ── Public API`,
      )
      .replace(
        'return this.#refuseTransiently(',
        'return this.#retryableBypass(',
      );
    const sourceFile = ts.createSourceFile(
      managerPath,
      mutatedSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const managerClass = sourceFile.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === 'SpawnRequestManager',
    );
    const guardedEvaluate = managerClass!.members.find(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === '#evaluateGuarded',
    );

    expect(guardedReturnViolations(guardedEvaluate!, sourceFile)).not.toEqual([]);
  });
});
