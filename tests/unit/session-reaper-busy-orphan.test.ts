/**
 * SessionReaper — busyOrphanDetection (observe-only). The inverse of
 * cpuAwareActiveProcessKeep: it FLAGS (never reaps) a session kept by an
 * `active-process` veto whose child is BURNING CPU while the session itself is
 * idle (idle prompt + flat transcript) across an extended dwell — the gap the
 * CPU-progress proxy can't catch (a useless-but-busy process looks "active").
 *
 * Contract under test (both sides of every boundary):
 *   - NEVER changes the verdict (always keep('active-process')).
 *   - Emits `busy-orphan-suspected` exactly ONCE, the tick the streak crosses
 *     busyOrphanConfirmTicks — not before, not every tick after.
 *   - Requires ALL of: flag on, under pressure, cpuFlat===false (busy child),
 *     positive-idle frame, static transcript. Any miss ⇒ no flag.
 *   - Emits `busy-orphan-cleared` when a confirmed suspect recovers.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SessionReaper,
  type SessionReaperDeps,
  type SessionReaperConfig,
  type PressureTier,
  type PressureReading,
} from '../../src/monitoring/SessionReaper.js';
import type { Session } from '../../src/core/types.js';
import type { TranscriptProbe } from '../../src/monitoring/transcriptProber.js';

const IDLE_FRAME = 'some output\n? for shortcuts\n> ';
const WORKING_FRAME = 'esc to interrupt\nWorking...';
const RESOLVED_STATIC: TranscriptProbe = { resolved: true, path: '/t.jsonl', size: 100, mtime: 1000 };

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'sess', status: 'running', tmuxSession: 't1',
    startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    ...over,
  };
}

function harness(opts: {
  cfg?: Partial<SessionReaperConfig>;
  deps?: Partial<SessionReaperDeps>;
  tier?: PressureTier;
  cpuStep?: number;   // descendant CPU-seconds added per sample (>0 ⇒ busy)
  withCpuDep?: boolean;
} = {}) {
  let now = 1_000_000;
  let frame = IDLE_FRAME;
  let cpu = 0;
  const step = opts.cpuStep ?? 50; // rising ⇒ cpuFlat===false (busy)
  const audits: Array<Record<string, unknown>> = [];
  const terminate = vi.fn(async () => ({ terminated: true }));
  const pressure: PressureReading = { tier: opts.tier ?? 'critical' };

  const deps: SessionReaperDeps = {
    listRunningSessions: () => [mkSession()],
    captureOutput: () => frame,
    hasActiveProcesses: () => true, // the active-process veto is in play
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => RESOLVED_STATIC, // constant ⇒ static after first tick
    isRecoveryActive: () => false,
    isRelayLeaseActive: () => false,
    hasPendingInjection: () => false,
    topicBinding: () => null,
    recentUserMessage: () => false,
    activeCommitmentForTopic: () => false,
    activeSubagentCount: () => 0,
    buildOrAutonomousActive: () => false,
    protectedSessions: () => [],
    pressure: () => pressure,
    terminate,
    markReaping: () => {},
    clearReaping: () => {},
    now: () => now,
    audit: (e) => audits.push(e),
    ...(opts.withCpuDep === false ? {} : { descendantCpuSeconds: () => { cpu += step; return cpu; } }),
    ...opts.deps,
  };

  const cfg: Partial<SessionReaperConfig> = {
    enabled: true, dryRun: false,
    minAgeMinutes: 0, confirmObservations: 99, confirmWindowMinutes: 0, // never actually reaps
    idleThresholdCriticalMinutes: 0, idleThresholdModerateMinutes: 0,
    finalGraceSec: 1, maxReapsPerTick: 0, maxReapsPerHour: 0,
    busyOrphanDetection: true, busyOrphanConfirmTicks: 2,
    ...opts.cfg,
  };

  const reaper = new SessionReaper(deps, cfg);
  return {
    reaper, audits, terminate,
    setNow: (n: number) => { now = n; },
    setFrame: (f: string) => { frame = f; },
    async ticks(n: number) {
      for (let i = 0; i < n; i++) { now = 1_000_000 + i * 120_000; await reaper.tick(); }
    },
  };
}

const suspectRows = (a: Array<Record<string, unknown>>) => a.filter(r => r.event === 'busy-orphan-suspected');
const clearedRows = (a: Array<Record<string, unknown>>) => a.filter(r => r.event === 'busy-orphan-cleared');

describe('busyOrphanDetection — observe-only flagging (both sides)', () => {
  it('busy child + idle session under pressure ⇒ ONE busy-orphan-suspected at the dwell, verdict unchanged', async () => {
    const h = harness({ cpuStep: 50 }); // rising CPU ⇒ cpuFlat=false
    // tick1: first CPU sample (undefined) + no prior transcript ⇒ not suspect.
    // tick2: cpuFlat=false + prior static + idle ⇒ streak 1.
    // tick3: streak 2 === confirmTicks ⇒ emit once.
    await h.ticks(3);
    expect(suspectRows(h.audits).length).toBe(1);
    expect(suspectRows(h.audits)[0].keptBy).toBe('active-process');
    // Never reaped — observe-only.
    expect(h.terminate).not.toHaveBeenCalled();
    // The decision audit shows the verdict stayed keep('active-process').
    const decisions = h.audits.filter(r => r.event === 'decision');
    expect(decisions.every(d => d.verdict === 'keep' && d.keptBy === 'active-process')).toBe(true);
  });

  it('does NOT emit before the dwell (streak < confirmTicks)', async () => {
    const h = harness({ cpuStep: 50, cfg: { busyOrphanConfirmTicks: 5 } });
    await h.ticks(3); // streak only reaches 2, threshold is 5
    expect(suspectRows(h.audits).length).toBe(0);
  });

  it('does NOT emit more than once after the dwell crosses (no per-tick flood)', async () => {
    const h = harness({ cpuStep: 50, cfg: { busyOrphanConfirmTicks: 2 } });
    await h.ticks(6); // streak keeps climbing, but emit only on the crossing tick
    expect(suspectRows(h.audits).length).toBe(1);
  });

  it('CPU-FLAT child (cpuFlat===true, the #722 relax case) ⇒ NOT a busy orphan', async () => {
    const h = harness({ cpuStep: 0 }); // constant CPU ⇒ flat ⇒ cpuFlat=true
    await h.ticks(4);
    expect(suspectRows(h.audits).length).toBe(0);
  });

  it('busy child but session NOT idle (working frame) ⇒ NOT suspect', async () => {
    const h = harness({ cpuStep: 50 });
    h.setFrame(WORKING_FRAME); // not positively idle
    await h.ticks(4);
    expect(suspectRows(h.audits).length).toBe(0);
  });

  it('flag OFF ⇒ never flags even with all conditions met', async () => {
    const h = harness({ cpuStep: 50, cfg: { busyOrphanDetection: false } });
    await h.ticks(4);
    expect(suspectRows(h.audits).length).toBe(0);
  });

  it('off-pressure (tier normal) ⇒ cpuFlat undefined ⇒ never flags', async () => {
    const h = harness({ cpuStep: 50, tier: 'normal' });
    await h.ticks(4);
    expect(suspectRows(h.audits).length).toBe(0);
  });

  it('no descendantCpuSeconds dep ⇒ cpuFlat undefined ⇒ never flags', async () => {
    const h = harness({ withCpuDep: false });
    await h.ticks(4);
    expect(suspectRows(h.audits).length).toBe(0);
  });

  it('confirmed suspect that recovers (child goes quiet) ⇒ busy-orphan-cleared', async () => {
    const h = harness({ cpuStep: 50, cfg: { busyOrphanConfirmTicks: 2 } });
    await h.ticks(3); // confirmed suspect
    expect(suspectRows(h.audits).length).toBe(1);
    // Now the child goes idle: frame still idle, but make it no longer a suspect
    // by flipping the frame to working (breaks looksIdleApartFromBusyChild).
    h.setFrame(WORKING_FRAME);
    h.setNow(1_000_000 + 3 * 120_000); await h.reaper.tick();
    expect(clearedRows(h.audits).length).toBe(1);
    expect(clearedRows(h.audits)[0].afterTicks).toBe(2);
  });
});
