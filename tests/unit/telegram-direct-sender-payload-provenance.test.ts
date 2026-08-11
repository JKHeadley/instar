import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * CMT-1248 asked for path-level behavioural tests driving each of the four DIRECT Telegram senders
 * with an invisible payload. Deriving before writing them showed the premise does not hold for three
 * of the four: their payload is built from a template whose literal prose guarantees visible
 * characters, so no caller input can make it invisible and the guard on that path cannot fire.
 *
 * A "behavioural test" for those would have to corrupt the template first — which tests the sabotage,
 * not the code. So the property actually worth pinning is the PROVENANCE: is this call site's payload
 * caller-controlled or template-built? That answer is what decides whether a path test is meaningful,
 * and it is the thing that would silently change under a refactor.
 *
 * If one of these templates ever becomes caller-controlled, the corresponding assertion here fails and
 * says so — which is the signal to write the behavioural test that is not writable today.
 */
const ROOT = path.resolve(__dirname, '../..');

function guardCallPayloadIsTemplateBuilt(
  file: string,
): { found: number; templateBuilt: number; callerSupplied: number } {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found = 0;
  let templateBuilt = 0;
  let callerSupplied = 0;
  /**
   * Resolve the binding IN SCOPE, not by name across the file. The first version of this searched the
   * whole source for `const <name> = ...`, and on routes.ts — 35,000 lines — it matched an unrelated
   * `text` declaration and reported the caller-supplied parameter as template-built. That is the exact
   * defect review pass 35 finding 6 raised against the send-funnel lint: relating a name to a
   * declaration it never proved. Reproducing it here, one screen away from the finding, is the reason
   * this comment exists.
   *
   * Walk OUTWARD from the guard call. If an enclosing function declares the name as a PARAMETER, the
   * value is caller-supplied. If an enclosing function body declares it as a literal-backed template,
   * it is template-built. The first enclosing binding found wins — that is what shadowing means.
   */
  const classifyInScope = (from: ts.Node, name: string): 'caller' | 'template' | 'unknown' => {
    let node: ts.Node | undefined = from;
    while (node) {
      const fn = node as ts.SignatureDeclarationBase & { body?: ts.Node };
      if (Array.isArray(fn.parameters)) {
        for (const prm of fn.parameters) {
          if (prm.name.getText(sf) === name) return 'caller';
        }
      }
      if (fn.body && ts.isBlock(fn.body as ts.Node)) {
        let verdict: 'template' | 'unknown' = 'unknown';
        for (const st of (fn.body as ts.Block).statements) {
          if (!ts.isVariableStatement(st)) continue;
          for (const d of st.declarationList.declarations) {
            if (d.name.getText(sf) !== name || !d.initializer) continue;
            const init = d.initializer;
            const literals = ts.isTemplateExpression(init)
              ? [init.head.text, ...init.templateSpans.map((x) => x.literal.text)].join('')
              : (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) ? init.text : null;
            if (literals !== null) verdict = literals.match(/[\p{L}\p{N}]/u) ? 'template' : 'unknown';
          }
        }
        if (verdict !== 'unknown') return verdict;
      }
      node = node.parent;
    }
    return 'unknown';
  };

  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
        && n.expression.text === 'assertTelegramPayloadVisible' && n.arguments.length >= 2) {
      found += 1;
      const arg = n.arguments[1];
      if (ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          let valueName: string | null = null;
          if (ts.isShorthandPropertyAssignment(prop)) valueName = prop.name.getText(sf);
          else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
            valueName = prop.initializer.text;
          }
          if (!valueName) continue;
          const verdict = classifyInScope(n, valueName);
          if (verdict === 'template') templateBuilt += 1;
          if (verdict === 'caller') callerSupplied += 1;
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return { found, templateBuilt, callerSupplied };
}

describe('direct Telegram senders — payload provenance decides whether a path test is meaningful', () => {
  it('the three wizard/probe senders build their payload from a template with literal prose', () => {
    // Their guard cannot fire: `Hey ${userName}, ${agentName} here — server's up and I'm online.`
    // keeps visible characters no matter what the interpolations contain. Same for the
    // `test-as-self ${nonce}` probe. The guard is defence-in-depth against a future refactor, and
    // these assertions are what notice that refactor.
    for (const f of [
      'src/commands/setup-wizard/codex-driver.ts',
      'src/commands/setup-wizard/gemini-driver.ts',
      'src/commands/test-as-self.ts',
    ]) {
      const r = guardCallPayloadIsTemplateBuilt(f);
      expect(r.found, `${f}: expected a guard call to analyse`).toBeGreaterThan(0);
      expect(
        r.templateBuilt,
        `${f}: the guarded payload is no longer template-built — it may now be caller-controlled, `
        + `which means a real path-level behavioural test IS writable and should be written (CMT-1248)`,
      ).toBeGreaterThan(0);
    }
  });

  it('the routes.ts demo sender takes caller-supplied text, so its path test IS meaningful', () => {
    const r = guardCallPayloadIsTemplateBuilt('src/server/routes.ts');
    expect(r.found).toBeGreaterThan(0);
    // `postAsDemoUser(topicId, text)` — `text` is a parameter, not a local template. Nothing in this
    // file backs it with literal prose, so an invisible value can reach the guard here.
    expect(r.templateBuilt).toBe(0);
    expect(r.callerSupplied, 'the demo sender should take its text from a parameter')
      .toBeGreaterThan(0);
  });
});
