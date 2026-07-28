/**
 * Regression guard for the inbound-queue BOOT-ORDER bug (boot-order-fix).
 *
 * THE BUG: in startServer()'s mesh block the inbound-queue engine is constructed
 * SYNCHRONOUSLY, but the gate guarding that construction read the module-level
 * `_sessionPoolStage()` getter — which at that point in the boot flow is still
 * the line-~443 stub `() => 'dark'`. The real getter is only assigned ~350 lines
 * BELOW the construction site. So `_sessionPoolStage() !== 'dark'` was ALWAYS
 * false at construction time → the engine never constructed → `/pool/queue`
 * 503'd forever, even with `inboundQueue.enabled=true` + a non-dark stage. The
 * feature had been inert since it shipped.
 *
 * THE FIX: the construction gate resolves the stage INLINE from config (via the
 * shared `resolveSessionPoolStage` helper) instead of calling the not-yet-wired
 * `_sessionPoolStage()` ref. These assertions pin that structurally — they FAIL
 * against the pre-fix source (gate calls `_sessionPoolStage()`) and PASS after.
 *
 * Source-text assertions are the right tier here: standing up the full
 * startServer mesh boot path in a test is heavyweight, and the bug is purely an
 * ordering relationship between two lines in that one file. The companion
 * `tests/unit/resolve-session-pool-stage.test.ts` proves the resolution LOGIC,
 * and `tests/integration/inbound-queue-route.test.ts` proves a constructed
 * engine actually serves 200 on /pool/queue (feature-alive).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.join(process.cwd(), 'src/commands/server.ts');

describe('Inbound-queue boot-order fix (engine constructs when configured)', () => {
  const src = fs.readFileSync(SERVER, 'utf-8');

  // Anchor on the construction gate region: from the engine-construction comment
  // to the QueueDrainLoop instantiation.
  function constructionRegion(): string {
    const start = src.indexOf('Durable Inbound Message Queue: engine construction');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('new qdlMod.QueueDrainLoop(', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it('the construction gate does NOT call the not-yet-wired _sessionPoolStage() getter', () => {
    const region = constructionRegion();
    // The bug was precisely `if (qcfg.enabled && _sessionPoolStage() !== 'dark')`.
    // After the fix the gate must NOT invoke the getter to decide construction.
    // (Strip the explanatory FIX comment, which legitimately names the old call
    // form in prose, before asserting on executable code.)
    const code = region
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('_sessionPoolStage()');
  });

  it('the construction gate resolves the stage INLINE before gating', () => {
    const region = constructionRegion();
    // Inline resolution computed at construction time (not the stale ref).
    expect(region).toContain('_sessionPoolStageNow');
    expect(region).toContain('resolveSessionPoolStage(');
    expect(region).toContain("liveConfig.get('multiMachine.sessionPool'");
    // The gate now reads the inline value.
    expect(region).toContain("_sessionPoolStageNow !== 'dark'");
  });

  it('the inline resolution sits BEFORE the gate it feeds (ordering correctness)', () => {
    const region = constructionRegion();
    const resolveAt = region.indexOf('const _sessionPoolStageNow');
    const gateAt = region.indexOf("if (qcfg.enabled && _sessionPoolStageNow !== 'dark')");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(resolveAt);
  });

  it('BOTH stage resolvers (boot gate + live getter) route through the shared helper (no drift)', () => {
    // The construction gate and the live _sessionPoolStage getter must both use
    // resolveSessionPoolStage — that single source of truth is what prevents the
    // original hand-duplicated divergence from recurring.
    const helperUses = src.split('resolveSessionPoolStage(').length - 1;
    // ≥2 callsites in server.ts (the boot-gate inline + the live getter); the
    // import line carries the symbol name but not the `(` call form.
    expect(helperUses).toBeGreaterThanOrEqual(2);
    // The live getter is still wired (the original assignment survives the fix).
    expect(src).toContain('_sessionPoolStage = () => {');
  });

  it('the stub default is unchanged (the getter still defaults dark until wired)', () => {
    // The fix does NOT remove the stub — runtime handlers (wireTelegramRouting,
    // onAccepted) legitimately close over the ref and see the wired impl when
    // they run AFTER boot. Only the SYNCHRONOUS boot-time read was buggy.
    expect(src).toContain("let _sessionPoolStage: () => string = () => 'dark'");
  });
});
