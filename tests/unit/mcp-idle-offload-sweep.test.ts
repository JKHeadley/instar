/**
 * McpIdleOffloadSweep — the automatic idle-offload trigger. Verifies the idle
 * clock accrual/reset, the fail-closed mid-tool-use handling, the eligibility →
 * offload path, dry-run (log only), keep-warm exclusion, and clock cleanup.
 */
import { describe, it, expect } from 'vitest';
import {
  McpIdleOffloadSweep,
  type McpIdleOffloadSweepDeps,
  type McpIdleOffloadSweepConfig,
  type HeavyLiveMcpProc,
} from '../../src/monitoring/McpIdleOffloadSweep.js';

const cfg = (over: Partial<McpIdleOffloadSweepConfig> = {}): McpIdleOffloadSweepConfig =>
  ({ enabled: true, idleOffloadMs: 1000, dryRun: false, ...over });

function harness(procs: HeavyLiveMcpProc[], over: Partial<McpIdleOffloadSweepDeps> = {}) {
  let t = 0;
  const offloads: Array<{ topicId: number; server: string }> = [];
  const logs: string[] = [];
  const deps: McpIdleOffloadSweepDeps = {
    listHeavyLiveMcpProcs: () => procs,
    sessionToTopic: (s) => (s === 'echo-5' ? 5 : null),
    signatureToServer: (sig) => (sig === 'playwright-mcp' ? 'playwright' : null),
    isMidToolUse: () => false,
    isKeepWarm: () => false,
    requestOffload: async (topicId, server) => { offloads.push({ topicId, server }); },
    now: () => t,
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, offloads, logs, advance: (ms: number) => { t += ms; }, setT: (v: number) => { t = v; } };
}

const pw = (pid: number, sessionName: string): HeavyLiveMcpProc => ({ pid, signatureId: 'playwright-mcp', sessionName });

describe('McpIdleOffloadSweep', () => {
  it('disabled ⇒ no actions, clears clocks', async () => {
    const h = harness([pw(4242, 'echo-5')]);
    const sweep = new McpIdleOffloadSweep(h.deps, cfg({ enabled: false }));
    expect(await sweep.tick()).toEqual([]);
    expect(sweep.trackedCount()).toBe(0);
  });

  it('does NOT offload before the idle window is crossed', async () => {
    const h = harness([pw(4242, 'echo-5')]);
    const sweep = new McpIdleOffloadSweep(h.deps, cfg({ idleOffloadMs: 1000 }));
    await sweep.tick();           // t=0: clock starts at 0
    h.advance(500);
    expect(await sweep.tick()).toEqual([]); // 500 < 1000
    expect(h.offloads).toHaveLength(0);
  });

  it('offloads once the continuous-idle window is crossed', async () => {
    const h = harness([pw(4242, 'echo-5')]);
    const sweep = new McpIdleOffloadSweep(h.deps, cfg({ idleOffloadMs: 1000 }));
    await sweep.tick();           // t=0
    h.advance(1200);
    const actions = await sweep.tick(); // idle 1200 >= 1000
    expect(actions).toEqual([{ topicId: 5, server: 'playwright', dryRun: false }]);
    expect(h.offloads).toEqual([{ topicId: 5, server: 'playwright' }]);
  });

  it('mid-tool-use RESETS the idle clock (fail-closed) — never offloads a busy session', async () => {
    let busy = true;
    const h = harness([pw(4242, 'echo-5')], { isMidToolUse: () => busy });
    const sweep = new McpIdleOffloadSweep(h.deps, cfg({ idleOffloadMs: 1000 }));
    await sweep.tick(); h.advance(2000);
    expect(await sweep.tick()).toEqual([]); // busy the whole time → no accrual
    busy = false; h.advance(500);
    expect(await sweep.tick()).toEqual([]); // only 500 since it went idle
    expect(h.offloads).toHaveLength(0);
  });

  it('an UNKNOWN (null) mid-tool-use also resets (fail-closed)', async () => {
    const h = harness([pw(4242, 'echo-5')], { isMidToolUse: () => null });
    const sweep = new McpIdleOffloadSweep(h.deps, cfg({ idleOffloadMs: 1000 }));
    await sweep.tick(); h.advance(5000);
    expect(await sweep.tick()).toEqual([]); // never accrues idle while unknown
  });

  it('keep-warm server is never auto-offloaded', async () => {
    const h = harness([pw(4242, 'echo-5')], { isKeepWarm: () => true });
    const sweep = new McpIdleOffloadSweep(h.deps, cfg({ idleOffloadMs: 1000 }));
    await sweep.tick(); h.advance(2000);
    expect(await sweep.tick()).toEqual([]);
  });

  it('dry-run LOGS the intended offload but does not request it', async () => {
    const h = harness([pw(4242, 'echo-5')]);
    const sweep = new McpIdleOffloadSweep(h.deps, cfg({ idleOffloadMs: 1000, dryRun: true }));
    await sweep.tick(); h.advance(1500);
    const actions = await sweep.tick();
    expect(actions).toEqual([{ topicId: 5, server: 'playwright', dryRun: true }]);
    expect(h.offloads).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('would offload') && l.includes('playwright'))).toBe(true);
  });

  it('a non-topic-bound session is skipped', async () => {
    const h = harness([pw(4242, 'headless-x')]); // sessionToTopic returns null for non echo-5
    const sweep = new McpIdleOffloadSweep(h.deps, cfg({ idleOffloadMs: 1000 }));
    await sweep.tick(); h.advance(2000);
    expect(await sweep.tick()).toEqual([]);
  });

  it('prunes clocks for procs that vanished', async () => {
    let procs = [pw(4242, 'echo-5'), pw(5555, 'echo-5')];
    const h = harness([], { listHeavyLiveMcpProcs: () => procs });
    const sweep = new McpIdleOffloadSweep(h.deps, cfg());
    await sweep.tick();
    expect(sweep.trackedCount()).toBe(2);
    procs = [pw(4242, 'echo-5')]; // 5555 vanished
    await sweep.tick();
    expect(sweep.trackedCount()).toBe(1);
  });
});
