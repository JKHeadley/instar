/**
 * SessionReaper — cpuAwareActiveProcessKeep (host-load-gated tightening of the
 * `active-process` existence-veto). The safety contract under test:
 *
 *   - OFF by default and a strict NO-OP off-pressure / when CPU can't be measured
 *     (the veto behaves exactly as before).
 *   - Under CPU pressure, a session kept ONLY by a child that EXISTS but is
 *     CPU-flat (a wedged/idle MCP child) no longer holds the session hostage —
 *     the reaper FALLS THROUGH to the stateful transcript-growth + positive-idle
 *     checks, which STILL must all clear before it is reap-eligible.
 *   - Every other keep-reason is untouched; a working child (CPU rising) keeps.
 *
 * Both sides of every boundary, per the Testing Integrity Standard.
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

interface Harness {
  reaper: SessionReaper;
  terminate: ReturnType<typeof vi.fn>;
  audits: Array<Record<string, unknown>>;
  setNow: (n: number) => void;
  setFrame: (f: string) => void;
  setCpu: (n: number) => void;
}

function harness(opts: {
  cfg?: Partial<SessionReaperConfig>;
  deps?: Partial<SessionReaperDeps>;
  tier?: PressureTier;
  withCpuDep?: boolean;
} = {}): Harness {
  let now = 1_000_000;
  let frame = IDLE_FRAME;
  let cpu = 0;
  const sessions = [mkSession()];
  const audits: Array<Record<string, unknown>> = [];
  const terminate = vi.fn(async () => ({ terminated: true }));
  const pressure: PressureReading = { tier: opts.tier ?? 'critical' };

  const deps: SessionReaperDeps = {
    listRunningSessions: () => sessions.filter(s => s.status === 'running'),
    captureOutput: () => frame,
    hasActiveProcesses: () => true, // the active-process veto is in play by default here
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => RESOLVED_STATIC,
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
    ...(opts.withCpuDep === false ? {} : { descendantCpuSeconds: () => cpu }),
    ...opts.deps,
  };

  const cfg: Partial<SessionReaperConfig> = {
    enabled: true, dryRun: false,
    minAgeMinutes: 0, confirmObservations: 2, confirmWindowMinutes: 0,
    idleThresholdCriticalMinutes: 0, idleThresholdModerateMinutes: 0,
    finalGraceSec: 1, maxReapsPerTick: 3, maxReapsPerHour: 12,
    cpuAwareActiveProcessKeep: true, cpuActiveMinRatePerSec: 0.02,
    ...opts.cfg,
  };

  return {
    reaper: new SessionReaper(deps, cfg),
    terminate, audits,
    setNow: (n) => { now = n; },
    setFrame: (f) => { frame = f; },
    setCpu: (n) => { cpu = n; },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// evaluate() — the pure tightening decision, given an explicit cpuFlat hint.
// ────────────────────────────────────────────────────────────────────────────
describe('cpuAwareActiveProcessKeep — evaluate() veto-relaxation (both sides)', () => {
  it('cpuFlat:true + idle + flat transcript ⇒ bypasses active-process ⇒ reap-eligible', () => {
    const h = harness();
    // First eval seeds lastTranscript; pass cpuFlat so the veto is relaxed and
    // we reach the stateful checks. Frame is positively idle, transcript static.
    const e = h.reaper.evaluate(mkSession(), { cpuFlat: true });
    expect(e.cpuTightened).toBe(true);
    // With no prior transcript this first eval keeps on transcript-unresolved?
    // No — RESOLVED_STATIC is resolved, so first-sighting growth is unknown→ the
    // reaper treats "no prior" + resolved as proceed; positive-idle then clears.
    expect(e.verdict).toBe('reap-eligible');
    expect(e.keptBy).toBe('all-clear');
  });

  it('cpuFlat:true but NOT positively idle (working frame) ⇒ still KEPT (no-positive-idle)', () => {
    const h = harness();
    h.setFrame(WORKING_FRAME);
    const e = h.reaper.evaluate(mkSession(), { cpuFlat: true });
    expect(e.cpuTightened).toBe(true);       // the veto WAS relaxed…
    expect(e.verdict).toBe('keep');          // …but positive-idle still protects it
    expect(e.keptBy).toBe('no-positive-idle');
  });

  it('cpuFlat:false ⇒ active-process veto STANDS (a working child keeps the session)', () => {
    const h = harness();
    const e = h.reaper.evaluate(mkSession(), { cpuFlat: false });
    expect(e.cpuTightened).toBeFalsy();
    expect(e.verdict).toBe('keep');
    expect(e.keptBy).toBe('active-process');
  });

  it('cpuFlat omitted (off-pressure / can\'t-measure) ⇒ active-process veto STANDS', () => {
    const h = harness();
    const e = h.reaper.evaluate(mkSession());
    expect(e.cpuTightened).toBeFalsy();
    expect(e.keptBy).toBe('active-process');
  });

  it('cpuFlat:true does NOT relax a DIFFERENT keep-reason (recent-user-message wins first)', () => {
    const h = harness({ deps: { topicBinding: () => 42, recentUserMessage: () => true } });
    const e = h.reaper.evaluate(mkSession(), { cpuFlat: true });
    expect(e.keptBy).toBe('recent-user-message'); // earlier guard, never reached active-process
    expect(e.cpuTightened).toBeFalsy();
  });

  it('cpuFlat:true + transcript GREW ⇒ still kept (growth protects past the relaxed veto)', () => {
    const h = harness();
    // Seed prior transcript via one tick, then grow it and eval with cpuFlat.
    h.setFrame(IDLE_FRAME);
    h.reaper.evaluate(mkSession(), { cpuFlat: true }); // seeds nothing (evaluate is stateless re: obs)
    // Drive a tick to record lastTranscript, then grow.
    return (async () => {
      await h.reaper.tick(); // records lastTranscript = size 100
      h.setCpu(0);
      // Grow the transcript: override probe to a bigger size on next eval.
      (h.reaper as unknown as { deps: SessionReaperDeps }).deps.probeTranscript =
        () => ({ resolved: true, path: '/t.jsonl', size: 999, mtime: 2000 });
      const e = h.reaper.evaluate(mkSession(), { cpuFlat: true });
      expect(e.cpuTightened).toBe(true);
      expect(e.keptBy).toBe('transcript-grew');
      expect(e.verdict).toBe('keep');
    })();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// tick() — cpuProgressFlat stateful delta + the gates around it.
// ────────────────────────────────────────────────────────────────────────────
describe('cpuAwareActiveProcessKeep — cpuProgressFlat gating via tick() (both sides)', () => {
  it('flag OFF ⇒ never tightens (flat CPU under pressure is ignored; session KEPT)', async () => {
    const h = harness({ cfg: { cpuAwareActiveProcessKeep: false } });
    h.setCpu(0);
    h.setNow(1_000_000); await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.audits.some(a => a.event === 'cpu-keep-tightened')).toBe(false);
  });

  it('tier NORMAL (off-pressure) ⇒ never tightens even with flat CPU + flag on', async () => {
    const h = harness({ tier: 'normal', cfg: { normalTierReaps: true } });
    h.setCpu(0);
    h.setNow(1_000_000); await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.audits.some(a => a.event === 'cpu-keep-tightened')).toBe(false);
  });

  it('first tick (no prior sample) ⇒ undefined ⇒ veto stands (no premature tighten)', async () => {
    const h = harness();
    h.setCpu(0);
    h.setNow(1_000_000); await h.reaper.tick(); // first sample only — cannot delta yet
    expect(h.audits.some(a => a.event === 'cpu-keep-tightened')).toBe(false);
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('under pressure + CPU stays FLAT across ticks + idle ⇒ tightens ⇒ reaped', async () => {
    const h = harness();
    h.setCpu(100); // constant ⇒ zero delta on every subsequent tick ⇒ flat
    // tick 0 is the seed sample (cpuFlat undefined ⇒ active-process veto stands,
    // session kept, candidacy not started). From tick 1 on, the delta is 0 ⇒ flat
    // ⇒ the veto is relaxed ⇒ candidate→candidate→reap (confirmObservations:2).
    h.setNow(1_000_000); await h.reaper.tick(); // seed sample
    h.setNow(1_120_000); await h.reaper.tick(); // flat ⇒ candidate (consecutive 1)
    h.setNow(1_240_000); await h.reaper.tick(); // flat ⇒ consecutive 2 → reap-pending
    h.setNow(1_360_000); await h.reaper.tick(); // grace elapsed → terminate
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.audits.some(a => a.event === 'cpu-keep-tightened')).toBe(true);
  });

  it('under pressure + CPU RISING (working) ⇒ veto stands ⇒ never reaped', async () => {
    const h = harness();
    let cpu = 0;
    (h.reaper as unknown as { deps: SessionReaperDeps }).deps.descendantCpuSeconds = () => { cpu += 50; return cpu; };
    h.setNow(1_000_000); await h.reaper.tick(); // +50 over 0 → but no prior, undefined
    h.setNow(1_120_000); await h.reaper.tick(); // +50 over 120s = 0.42/s ≫ 0.02 ⇒ NOT flat
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.audits.some(a => a.event === 'cpu-keep-tightened')).toBe(false);
  });

  it('descendantCpuSeconds dep ABSENT ⇒ undefined ⇒ veto stands (no tighten)', async () => {
    const h = harness({ withCpuDep: false });
    h.setNow(1_000_000); await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.audits.some(a => a.event === 'cpu-keep-tightened')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Active-process relaxation PARITY (bypassActiveProcessKeep plumbed to terminate).
// The reaper's evaluate() relaxes the active-process veto, but the terminate
// AUTHORITY re-runs the un-relaxed shared ReapGuard — so without the reaper
// carrying its relaxation through, the authority re-vetoes the very reap the
// reaper authorized (observed live: 1,532× skipped:active-process). These assert
// the reaper passes `bypassActiveProcessKeep` IFF its reap relaxed that veto.
// Spec: docs/specs/reaper-active-process-relaxation-parity.md.
// ────────────────────────────────────────────────────────────────────────────
describe('active-process relaxation parity — reaper carries the bypass to terminate', () => {
  it('reap via cpuFlat relaxation ⇒ terminate called with bypassActiveProcessKeep:true', async () => {
    const h = harness();
    h.setCpu(100); // constant ⇒ flat delta ⇒ active-process veto relaxed under pressure
    h.setNow(1_000_000); await h.reaper.tick(); // seed sample
    h.setNow(1_120_000); await h.reaper.tick(); // flat ⇒ candidate 1
    h.setNow(1_240_000); await h.reaper.tick(); // flat ⇒ candidate 2 → reap-pending
    h.setNow(1_360_000); await h.reaper.tick(); // grace elapsed → performReap
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.terminate).toHaveBeenCalledWith('s1', 'reaped-idle', { bypassActiveProcessKeep: true, workEvidence: [] });
  });

  it('reap via stale-idle relaxation (no CPU dep) ⇒ bypassActiveProcessKeep:true', async () => {
    // cpuAware OFF; the 8h-stale-idle path relaxes the active-process veto for a
    // session whose only blocker is its own idle children (e.g. the MCP stack).
    // This is the path that fires in production.
    const h = harness({
      cfg: { cpuAwareActiveProcessKeep: false, reapStaleIdleWithActiveChildren: true, staleCommitmentWindowMinutes: 480 },
      deps: { topicBinding: () => 42, recentUserMessage: () => false },
    });
    h.setNow(1_000_000); await h.reaper.tick(); // staleIdle relaxes ⇒ candidate 1
    h.setNow(1_120_000); await h.reaper.tick(); // candidate 2 → reap-pending
    h.setNow(1_240_000); await h.reaper.tick(); // grace elapsed → performReap
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.terminate).toHaveBeenCalledWith('s1', 'reaped-idle', { bypassActiveProcessKeep: true, workEvidence: [] });
  });

  it('reap of a session with NO active process ⇒ bypassActiveProcessKeep:false (no-op bypass)', async () => {
    // No active-process veto ever fired, so nothing was relaxed — the flag must
    // be false (the authority's active-process check is a no-op here anyway).
    const h = harness({ deps: { hasActiveProcesses: () => false } });
    h.setCpu(0);
    h.setNow(1_000_000); await h.reaper.tick(); // candidate 1
    h.setNow(1_120_000); await h.reaper.tick(); // candidate 2 → reap-pending
    h.setNow(1_240_000); await h.reaper.tick(); // grace elapsed → performReap
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.terminate).toHaveBeenCalledWith('s1', 'reaped-idle', { bypassActiveProcessKeep: false, workEvidence: [] });
  });
});
