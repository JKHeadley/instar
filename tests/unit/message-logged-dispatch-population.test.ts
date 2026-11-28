/**
 * Every `onMessageLogged` dispatch site contains its subscriber's failure.
 *
 * `onMessageLogged` is a settable subscriber seam on the messaging adapters, and in
 * production the subscriber is server.ts's closure that performs the TopicMemory
 * dual-write (`writeSlackLogRow` -> `TopicRowWriter.writeRow` -> `insertKeyedMessage` ->
 * SQLite). Nothing between there and the dispatch catches, so a bare dispatch site lets a
 * write failure destroy the work that follows it — on the inbound Slack paths, the whole
 * message before the reaction and the hand-off to the handler.
 *
 * Measured on instar upstream d76d018c0 (PROP-1289): of the dispatch sites, FOUR were bare
 * and FOUR were guarded, and the four guarded ones were already the repo's own pattern.
 * Per-site behavioural tests prove the containment works; this one enumerates the whole
 * POPULATION, so the next dispatch site cannot be added bare and a later refactor cannot
 * quietly un-guard one. A fix that establishes its property for the sites one session
 * happened to look at is how the next session finds the sibling still broken.
 *
 * NON-DISPATCH CALLS are listed explicitly rather than pattern-excluded: a call to a class
 * that OWNS an `onMessageLogged` method (PresenceProxy, PromisedUpdateCapture) is an
 * ordinary method call, not a dispatch to a nullable subscriber. A new call site that is
 * neither guarded nor on that list fails this test, which is the point — it forces the
 * author to say which kind it is.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../../src');

/** Receivers that OWN an `onMessageLogged` method — calling one is not a dispatch. */
const OWN_METHOD_RECEIVERS: ReadonlyArray<{ receiver: string; why: string }> = [
  { receiver: 'presenceProxy', why: 'PresenceProxy.onMessageLogged is its own method (src/monitoring/PresenceProxy.ts)' },
  { receiver: 'capture', why: 'PromisedUpdateCapture.onMessageLogged is its own method (src/monitoring/PromisedUpdateCapture.ts)' },
];

interface Site {
  file: string; line: number; receiver: string; text: string;
  guarded: boolean;
  /** The nearest enclosing `catch` body, when the dispatch is caught at all. */
  catchText: string | null;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...tsFiles(full)); continue; }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/** The NEAREST ancestor `try` with a `catch` that contains this node, or null if uncaught. */
function nearestCaughtTry(node: ts.Node): ts.TryStatement | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isTryStatement(n) && n.catchClause && n.tryBlock.getStart() <= node.getStart() && node.getEnd() <= n.tryBlock.getEnd()) {
      return n;
    }
  }
  return null;
}

/** Every call of a property named `onMessageLogged`, with its receiver and guard state. */
function dispatchSitesIn(file: string, sourceText: string): Site[] {
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: Site[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const access = ts.isNonNullExpression(callee) ? callee.expression : callee;
      if (ts.isPropertyAccessExpression(access) && access.name.text === 'onMessageLogged') {
        const receiverText = access.expression.getText(sf);
        const receiver = receiverText.split(/[.!?]/).filter(Boolean).pop() ?? receiverText;
        const caught = nearestCaughtTry(node);
        sites.push({
          file: path.relative(SRC, file),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          receiver,
          text: node.getText(sf).split('\n')[0].slice(0, 80),
          guarded: caught !== null,
          catchText: caught?.catchClause?.block.getText(sf) ?? null,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

const allSites = tsFiles(SRC).flatMap((f) => dispatchSitesIn(f, fs.readFileSync(f, 'utf8')));
const ownMethodNames = new Set(OWN_METHOD_RECEIVERS.map((r) => r.receiver));
const subscriberDispatches = allSites.filter((s) => !ownMethodNames.has(s.receiver));

describe('onMessageLogged dispatch population', () => {
  // ── Positive controls: an empty or blind scan must not be able to pass ──

  it('the scan finds the known call sites (a blind matcher cannot pass vacuously)', () => {
    expect(allSites.length).toBeGreaterThanOrEqual(8);
    expect(subscriberDispatches.length).toBeGreaterThanOrEqual(5);
    // Both buckets are live: the own-method list is not dead weight.
    expect(allSites.some((s) => ownMethodNames.has(s.receiver))).toBe(true);
  });

  it('the guard detector can say BARE (it is not hard-wired to true)', () => {
    const bare = dispatchSitesIn('synthetic-bare.ts', [
      'class A {',
      '  onMessageLogged: ((e: unknown) => void) | null = null;',
      '  go(e: unknown) { this.onMessageLogged?.(e); }',
      '}',
    ].join('\n'));
    expect(bare).toHaveLength(1);
    expect(bare[0].guarded).toBe(false);

    const guarded = dispatchSitesIn('synthetic-guarded.ts', [
      'class A {',
      '  onMessageLogged: ((e: unknown) => void) | null = null;',
      '  go(e: unknown) { try { this.onMessageLogged?.(e); } catch { /* contained */ } }',
      '}',
    ].join('\n'));
    expect(guarded).toHaveLength(1);
    expect(guarded[0].guarded).toBe(true);

    // A `try` with only a `finally` does NOT catch the throw.
    const finallyOnly = dispatchSitesIn('synthetic-finally.ts', [
      'class A {',
      '  onMessageLogged: ((e: unknown) => void) | null = null;',
      '  go(e: unknown) { try { this.onMessageLogged?.(e); } finally { this.done(); } }',
      '  done() {}',
      '}',
    ].join('\n'));
    expect(finallyOnly).toHaveLength(1);
    expect(finallyOnly[0].guarded).toBe(false);
  });

  // ── The population assertion ──

  it('no subscriber dispatch is bare', () => {
    const bare = subscriberDispatches.filter((s) => !s.guarded);
    expect(
      bare.map((s) => `${s.file}:${s.line} (${s.receiver}) ${s.text}`),
    ).toEqual([]);
  });

  // ── Caught, but at the right altitude ──
  //
  // A dispatch can be inside a try and still do the damage, if the catch that holds it is
  // the OPERATION's error handler. On upstream d76d018c0 the Slack agent-reply route
  // dispatched at routes.ts:23524 inside the route's own `try`, whose catch answers
  // `res.status(500)` — so a subscriber's TopicMemory failure, AFTER the reply had already
  // been sent and its delivery id recorded, reported the send itself as failed. That is the
  // ambiguous-failure shape the same handler takes care to avoid four lines earlier (it
  // answers 408 on a send timeout precisely "so a redrive NEVER re-posts a message the API
  // may have taken"), and it also skipped the promise tracking below it.
  //
  // This instrument's bound, stated rather than implied: it can only see a catch that
  // ANSWERS THE CALLER (a 5xx). A catch at the wrong altitude that is silent about it is
  // not visible here, and no per-site test would catch that either.

  it('no dispatch failure is reported to the caller as the operation failing', () => {
    const answersCaller = subscriberDispatches.filter(
      (s) => s.catchText !== null && /res\s*\.\s*status\s*\(\s*5\d\d/.test(s.catchText),
    );
    expect(
      answersCaller.map((s) => `${s.file}:${s.line} (${s.receiver}) caught by a 5xx handler`),
    ).toEqual([]);
  });

  it('the 5xx-altitude detector can say WRONG-ALTITUDE (positive control)', () => {
    const wrong = dispatchSitesIn('synthetic-5xx.ts', [
      'const route = async (ctx: any, res: any) => {',
      '  try {',
      '    await ctx.slack.send();',
      '    ctx.slack.onMessageLogged({ text: "x" });',
      '    ctx.slack.trackPromise();',
      '  } catch (err) {',
      '    res.status(500).json({ error: String(err) });',
      '  }',
      '};',
    ].join('\n'));
    expect(wrong).toHaveLength(1);
    expect(wrong[0].guarded).toBe(true);                       // it IS caught …
    expect(wrong[0].catchText).toMatch(/res\.status\(500\)/);  // … by the 5xx handler
  });
});
