import { describe, it, expect } from 'vitest';
import {
  runKillFunnel,
  type KillTarget,
  type KillFunnelDeps,
  type KillFunnelOpts,
  type KillArmState,
} from '../../src/monitoring/ExternalHogKillFunnel.js';
import { classContentHash, type ArmMarker } from '../../src/monitoring/ExternalHogArmMarker.js';
import type { ExternalHogFacts } from '../../src/monitoring/ExternalHogFloor.js';

/**
 * ExternalHogKillFunnel — the hardened kill sequence (CMT-1901, §4). The watch-only guarantee
 * is by construction: NO signal unless a live kill is authorized (enabled && !dryRun && valid
 * PIN marker). Fully testable via injected I/O — no real process is ever signalled.
 */

const CLASS = 'vscode-exthost';
const HASH = classContentHash(['^Code Helper \\(Plugin\\)$', 'extensionHost']);
const target: KillTarget = { pid: 5335, startTime: 'S', commandHash: 'ch', classId: CLASS };

/** Facts the §4 floor PERMITS (own-uid, orphaned in-envelope exthost, sustained hog). */
function permitFacts(): ExternalHogFacts {
  return {
    name: 'Code Helper (Plugin)',
    argv: '/App/Code Helper (Plugin) --type=extensionHost --parentPid=1',
    pid: 5335,
    ownerAppRunning: false,
    sustainedHighCpu: true,
    isInstarProcess: false,
    ownerRootDaemon: false,
    hasLaunchctlLabel: false,
    targetUid: 501,
    ownEuid: 501,
  };
}

const LIVE_ARM: KillArmState = {
  config: { enabled: true, dryRun: false },
  marker: { armEpoch: 5, armedBy: 'pin', armedAt: 't', allowlistSnapshot: { [CLASS]: HASH } } as ArmMarker,
  lastDisarmEpoch: 4,
};

/** A configurable mock deps that RECORDS every signal sent. */
function mkDeps(over: Partial<KillFunnelDeps> & { arm?: KillArmState; facts?: ExternalHogFacts | null; alive?: boolean; writing?: boolean } = {}): {
  deps: KillFunnelDeps;
  signals: Array<{ pid: number; signal: string }>;
} {
  const signals: Array<{ pid: number; signal: string }> = [];
  const arm = over.arm ?? LIVE_ARM;
  const facts = over.facts === undefined ? permitFacts() : over.facts;
  const deps: KillFunnelDeps = {
    reReadFacts: over.reReadFacts ?? (() => facts),
    reReadArmState: over.reReadArmState ?? (() => arm),
    currentClassContentHash: over.currentClassContentHash ?? (() => HASH),
    hasOpenWritableWorkspaceFile: over.hasOpenWritableWorkspaceFile ?? (() => over.writing ?? false),
    sendSignal: (pid, signal) => signals.push({ pid, signal }),
    stillAlive: over.stillAlive ?? (() => over.alive ?? true),
    wait: over.wait ?? (async () => {}),
  };
  return { deps, signals };
}
const opts = (over: Partial<KillFunnelOpts> = {}): KillFunnelOpts => ({ sigtermGraceMs: 12_000, maxKillDeferrals: 3, currentDeferrals: 0, ...over });

describe('runKillFunnel — WATCH-ONLY: no signal unless authorized', () => {
  it('dryRun:true → would-kill (dry-run), NO signal sent', async () => {
    const { deps, signals } = mkDeps({ arm: { ...LIVE_ARM, config: { enabled: true, dryRun: true } } });
    const out = await runKillFunnel(target, opts(), deps);
    expect(out).toEqual({ action: 'would-kill', reason: 'dry-run' });
    expect(signals).toHaveLength(0);
  });
  it('enabled && !dryRun but NO valid marker → would-kill (not-armed), NO signal', async () => {
    const { deps, signals } = mkDeps({ arm: { config: { enabled: true, dryRun: false }, marker: null, lastDisarmEpoch: 0 } });
    const out = await runKillFunnel(target, opts(), deps);
    expect(out).toEqual({ action: 'would-kill', reason: 'not-armed' });
    expect(signals).toHaveLength(0);
  });
  it('a disarmed marker (armEpoch <= lastDisarmEpoch) → would-kill, NO signal', async () => {
    const { deps, signals } = mkDeps({ arm: { ...LIVE_ARM, lastDisarmEpoch: 5 } });
    const out = await runKillFunnel(target, opts(), deps);
    expect(out.action).toBe('would-kill');
    expect(signals).toHaveLength(0);
  });
});

describe('runKillFunnel — floor re-check aborts (no signal)', () => {
  it('floor vetoes on re-read (e.g. now root-owned) → aborted, NO signal', async () => {
    const { deps, signals } = mkDeps({ facts: { ...permitFacts(), ownerRootDaemon: true } });
    const out = await runKillFunnel(target, opts(), deps);
    expect(out.action).toBe('aborted');
    expect(signals).toHaveLength(0);
  });
  it('identity gone on re-read → aborted, NO signal', async () => {
    const { deps, signals } = mkDeps({ facts: null });
    const out = await runKillFunnel(target, opts(), deps);
    expect(out).toEqual({ action: 'aborted', reason: 'identity-changed-or-gone' });
    expect(signals).toHaveLength(0);
  });
});

describe('runKillFunnel — armed path', () => {
  it('process exits during grace → sigterm-exited (SIGTERM sent, NO SIGKILL)', async () => {
    const { deps, signals } = mkDeps({ alive: false });
    const out = await runKillFunnel(target, opts(), deps);
    expect(out).toEqual({ action: 'sigterm-exited' });
    expect(signals).toEqual([{ pid: 5335, signal: 'SIGTERM' }]);
  });
  it('still alive, not writing → SIGTERM then SIGKILL → killed', async () => {
    const { deps, signals } = mkDeps({ alive: true, writing: false });
    const out = await runKillFunnel(target, opts(), deps);
    expect(out).toEqual({ action: 'killed' });
    expect(signals).toEqual([{ pid: 5335, signal: 'SIGTERM' }, { pid: 5335, signal: 'SIGKILL' }]);
  });
  it('disarmed DURING grace → aborted, NO SIGKILL (the SIGTERM already sent is graceful)', async () => {
    // Arm state flips to disarmed on the 2nd read (post-grace).
    let calls = 0;
    const { deps, signals } = mkDeps({
      alive: true,
      reReadArmState: () => (++calls <= 1 ? LIVE_ARM : { ...LIVE_ARM, lastDisarmEpoch: 5 }),
    });
    const out = await runKillFunnel(target, opts(), deps);
    expect(out.action).toBe('aborted');
    expect(signals).toEqual([{ pid: 5335, signal: 'SIGTERM' }]); // SIGTERM only, no SIGKILL
  });
  it('writing a workspace file + under the defer cap → deferred, NO SIGKILL', async () => {
    const { deps, signals } = mkDeps({ alive: true, writing: true });
    const out = await runKillFunnel(target, opts({ currentDeferrals: 0, maxKillDeferrals: 3 }), deps);
    expect(out).toEqual({ action: 'deferred', reason: 'writable-workspace-file' });
    expect(signals).toEqual([{ pid: 5335, signal: 'SIGTERM' }]);
  });
  it('writing but the defer cap is exhausted → proceeds to SIGKILL → killed', async () => {
    const { deps, signals } = mkDeps({ alive: true, writing: true });
    const out = await runKillFunnel(target, opts({ currentDeferrals: 3, maxKillDeferrals: 3 }), deps);
    expect(out).toEqual({ action: 'killed' });
    expect(signals).toContainEqual({ pid: 5335, signal: 'SIGKILL' });
  });
});
