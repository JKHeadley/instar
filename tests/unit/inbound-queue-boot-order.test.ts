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

describe('Inbound-queue boot-order fix (engine constructs when configured, independent of rollout stage)', () => {
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

  it('the construction gate resolves the pool switch INLINE before gating', () => {
    const region = constructionRegion();
    // Inline resolution computed at construction time (not the stale ref).
    expect(region).toContain('_sessionPoolEnabledNow');
    expect(region).toContain('inboundQueuePoolGateOpen(');
    expect(region).toContain("liveConfig.get('multiMachine.sessionPool'");
    expect(region).toContain('if (qcfg.enabled && _sessionPoolEnabledNow)');
  });

  it('the construction gate is DECOUPLED from the rollout stage (CMT-1117)', () => {
    // A StageAdvancer revert to 'dark' must not switch off a graduated queue at
    // the next boot: the gate reads the pool's enabled switch, never the stage.
    const code = constructionRegion()
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/!==\s*'dark'/);
    expect(code).not.toContain('resolveSessionPoolStage(');
  });

  it('the boot sweep gate is decoupled from the rollout stage too (no custody expiry on a revert)', () => {
    const at = src.indexOf('const queueWillRun');
    expect(at).toBeGreaterThan(0);
    const region = src.slice(at, src.indexOf(': { run: true };', at));
    expect(region).toContain('inboundQueuePoolGateOpenAtBoot(poolRaw)');
    expect(region).not.toContain("stage ?? 'dark'");
  });

  it('the inline resolution sits BEFORE the gate it feeds (ordering correctness)', () => {
    const region = constructionRegion();
    const resolveAt = region.indexOf('const _sessionPoolEnabledNow');
    const gateAt = region.indexOf('if (qcfg.enabled && _sessionPoolEnabledNow)');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(resolveAt);
  });

  it('the live stage getter still routes through the shared helper', () => {
    expect(src.split('resolveSessionPoolStage(').length - 1).toBeGreaterThanOrEqual(1);
    expect(src).toContain('_sessionPoolStage = () => {');
  });

  it('the stub default is unchanged (the getter still defaults dark until wired)', () => {
    // The fix does NOT remove the stub — runtime handlers (wireTelegramRouting,
    // onAccepted) legitimately close over the ref and see the wired impl when
    // they run AFTER boot. Only the SYNCHRONOUS boot-time read was buggy.
    expect(src).toContain("let _sessionPoolStage: () => string = () => 'dark'");
  });

  it('at stage dark the queue drain delivers on THIS machine only — no router, no forced re-place (CMT-1117 second pass)', () => {
    const at = src.indexOf('_drainLocalDeliver = async (dmsg, handover) => {');
    expect(at).toBeGreaterThan(0);
    const drain = src.slice(at, at + 2500);
    expect(drain).toContain("const poolDark = _sessionPoolStage() === 'dark';");
    expect(drain).toMatch(/poolDark \? \{ action: 'handled-locally', acked: true \} : await _sessionRouter!\.route\(/);
    const fr = src.indexOf('forceReplace: async (msg) => {');
    expect(fr).toBeGreaterThan(0);
    expect(src.slice(fr, fr + 600)).toContain("if (_sessionPoolStage() === 'dark') return false;");
  });
});
