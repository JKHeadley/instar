/**
 * SessionReaper — the safety-critical classifier. THE hard requirement under
 * test: NEVER reap a working session. Every protect-gate, the positive-idle
 * requirement, the confidence contract (unresolved → KEEP), render-stasis,
 * hysteresis, pressure tiers, the two-phase reap, dry-run, and the bounded
 * blast radius + auto-disable.
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

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'sess', status: 'running', tmuxSession: 't1',
    startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    ...over,
  };
}

const RESOLVED_STATIC: TranscriptProbe = { resolved: true, path: '/t.jsonl', size: 100, mtime: 1000 };

interface Harness {
  reaper: SessionReaper;
  terminate: ReturnType<typeof vi.fn>;
  audits: Array<Record<string, unknown>>;
  setNow: (n: number) => void;
  setFrame: (f: string) => void;
  setTranscript: (p: TranscriptProbe) => void;
  reaping: Set<string>;
}

function harness(opts: {
  cfg?: Partial<SessionReaperConfig>;
  deps?: Partial<SessionReaperDeps>;
  sessions?: Session[];
  tier?: PressureTier;
} = {}): Harness {
  let now = 1_000_000;
  let frame = IDLE_FRAME;
  let transcript = RESOLVED_STATIC;
  const sessions = opts.sessions ?? [mkSession()];
  const reaping = new Set<string>();
  const audits: Array<Record<string, unknown>> = [];
  const terminate = vi.fn(async () => ({ terminated: true }));
  const pressure: PressureReading = { tier: opts.tier ?? 'critical' };

  const deps: SessionReaperDeps = {
    listRunningSessions: () => sessions.filter(s => s.status === 'running'),
    captureOutput: () => frame,
    hasActiveProcesses: () => false,
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => transcript,
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
    markReaping: (id) => reaping.add(id),
    clearReaping: (id) => reaping.delete(id),
    now: () => now,
    audit: (e) => audits.push(e),
    ...opts.deps,
  };

  const cfg: Partial<SessionReaperConfig> = {
    enabled: true, dryRun: false,
    minAgeMinutes: 0, confirmObservations: 2, confirmWindowMinutes: 0,
    idleThresholdCriticalMinutes: 0, idleThresholdModerateMinutes: 0,
    finalGraceSec: 1, maxReapsPerTick: 3, maxReapsPerHour: 12,
    ...opts.cfg,
  };

  return {
    reaper: new SessionReaper(deps, cfg),
    terminate, audits, reaping,
    setNow: (n) => { now = n; },
    setFrame: (f) => { frame = f; },
    setTranscript: (p) => { transcript = p; },
  };
}

/** Drive the reaper to a kill: 3 static-frame ticks (candidate→candidate→reap-pending matures). */
async function driveToReap(h: Harness): Promise<void> {
  h.setNow(1_000_000); await h.reaper.tick();           // tick1: consecutive=1
  h.setNow(1_120_000); await h.reaper.tick();           // tick2: consecutive=2 → reap-pending
  h.setNow(1_240_000); await h.reaper.tick();           // tick3: grace elapsed → terminate
}

describe('SessionReaper — protect-gates each force KEEP', () => {
  const cases: Array<[string, Partial<SessionReaperDeps>, string]> = [
    ['protected set', { protectedSessions: () => ['t1'] }, 'protected'],
    ['recovery in flight', { isRecoveryActive: () => true }, 'recovery-in-flight'],
    ['pending injection', { hasPendingInjection: () => true }, 'pending-injection'],
    ['relay lease', { isRelayLeaseActive: () => true }, 'relay-lease'],
    ['active process', { hasActiveProcesses: () => true }, 'active-process'],
    ['active subagent', { activeSubagentCount: () => 1 }, 'active-subagent'],
    ['build/autonomous', { buildOrAutonomousActive: () => true }, 'structural-long-work'],
    ['recent user msg', { topicBinding: () => 42, recentUserMessage: () => true }, 'recent-user-message'],
    ['open commitment', { topicBinding: () => 42, activeCommitmentForTopic: () => true }, 'open-commitment'],
  ];
  for (const [name, deps, expectedGate] of cases) {
    it(`KEEPs on ${name}`, () => {
      const h = harness({ deps });
      const e = h.reaper.evaluate(mkSession());
      expect(e.verdict).toBe('keep');
      expect(e.keptBy).toBe(expectedGate);
    });
  }

  it('KEEPs a freshly-spawned session (spawn grace)', () => {
    const h = harness({ cfg: { minAgeMinutes: 30 }, sessions: [mkSession({ startedAt: new Date(Date.now()).toISOString() })] });
    // now() is 1_000_000 ms; startedAt ~ Date.now() (much larger) → age negative → grace.
    const e = h.reaper.evaluate(h.reaper['deps'].listRunningSessions()[0]);
    expect(e.keptBy).toBe('spawn-grace');
  });
});

describe('SessionReaper — positive-evidence & confidence contract', () => {
  it('KEEPs when no positive idle prompt (absence of activity is NOT idle)', () => {
    const h = harness();
    h.setFrame('just some leftover output with no ready prompt');
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('keep');
    expect(e.keptBy).toBe('no-positive-idle');
  });

  it('KEEPs when the pane shows an active-work marker (esc to interrupt)', () => {
    const h = harness();
    h.setFrame(WORKING_FRAME);
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('keep');
  });

  it('KEEPs when the transcript is unresolved (Codex/no-claudeSessionId)', () => {
    const h = harness();
    h.setTranscript({ resolved: false, path: '', size: 0, mtime: 0 });
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('keep');
    expect(e.keptBy).toBe('transcript-unresolved');
    expect(e.confidence).toBe('low');
  });

  it('KEEPs when main process is uninspectable (cannot inspect → KEEP)', () => {
    const h = harness({ deps: { mainProcessActive: () => undefined } });
    const e = h.reaper.evaluate(mkSession());
    expect(e.keptBy).toBe('process-uninspectable');
  });

  it('is reap-eligible only when ALL gates clear', () => {
    const h = harness();
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('reap-eligible');
    expect(e.keptBy).toBe('all-clear');
  });
});

describe('SessionReaper — transcript growth across ticks keeps a working session', () => {
  it('KEEPs when the transcript grew between ticks (mid-generation, quiet pane)', async () => {
    const h = harness();
    h.setNow(1_000_000); await h.reaper.tick(); // baseline transcript captured
    // transcript grows → working, even though pane is the idle frame
    h.setTranscript({ ...RESOLVED_STATIC, size: 999 });
    h.setNow(1_120_000); await h.reaper.tick();
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
  });
});

describe('SessionReaper — render stasis', () => {
  it('does NOT reap while the pane keeps changing (a thinking session twitches)', async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      h.setFrame(IDLE_FRAME + `\n[tick ${i}]`); // frame changes each tick
      h.setNow(1_000_000 + i * 120_000);
      await h.reaper.tick();
    }
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('reaps a genuinely static, positively-idle session', async () => {
    const h = harness();
    await driveToReap(h);
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.terminate).toHaveBeenCalledWith('s1', 'reaped-idle');
  });
});

describe('SessionReaper — hysteresis', () => {
  it('does NOT reap before confirmObservations consecutive ticks', async () => {
    const h = harness({ cfg: { confirmObservations: 4 } });
    h.setNow(1_000_000); await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled(); // only 3 < 4 confirmations
  });
});

describe('SessionReaper — pressure tiers', () => {
  it('Normal tier reaps NOTHING (pure pressure-relief valve)', async () => {
    const h = harness({ tier: 'normal', cfg: { normalTierReaps: false } });
    for (let i = 0; i < 8; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('Critical tier reaps a static idle session', async () => {
    const h = harness({ tier: 'critical' });
    await driveToReap(h);
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('SessionReaper — two-phase reap', () => {
  it('marks reap-pending then terminates after the grace window', async () => {
    const h = harness();
    h.setNow(1_000_000); await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    expect(h.reaping.has('s1')).toBe(true);       // reap-pending leased
    expect(h.terminate).not.toHaveBeenCalled();   // not yet
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });

  it('ABORTS the reap if the pane changes during the grace window', async () => {
    const h = harness();
    h.setNow(1_000_000); await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick(); // reap-pending
    expect(h.reaping.has('s1')).toBe(true);
    h.setFrame(IDLE_FRAME + '\nnew output!'); // session rendered something
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.reaping.has('s1')).toBe(false); // lease released on abort
  });
});

describe('SessionReaper — dry-run and blast radius', () => {
  it('dry-run logs would-reap and does NOT terminate', async () => {
    const h = harness({ cfg: { dryRun: true } });
    await driveToReap(h);
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.audits.some(a => a.event === 'would-reap')).toBe(true);
  });

  it('auto-disables to dry-run after an ambiguous reap outcome', async () => {
    const h = harness();
    h.terminate.mockResolvedValueOnce({ terminated: false, skipped: 'already-completed' });
    await driveToReap(h);
    expect(h.audits.some(a => a.event === 'reap-skipped-auto-disable')).toBe(true);
    // a subsequent maturity would be dry-run now
    const snap = h.reaper.snapshot();
    expect(snap.autoDisabled).toBe(true);
    expect(snap.dryRun).toBe(true);
  });

  it('respects maxReapsPerHour across sessions', async () => {
    const sessions = [mkSession({ id: 'a', tmuxSession: 'ta' }), mkSession({ id: 'b', tmuxSession: 'tb' })];
    const h = harness({ sessions, cfg: { maxReapsPerHour: 1, maxReapsPerTick: 5 } });
    await driveToReap(h);
    expect(h.terminate).toHaveBeenCalledTimes(1); // budget caps the 2nd
  });

  it('releases the reaping lease when a matured reap is budget-gated (no idle-kill lockout)', async () => {
    const sessions = [mkSession({ id: 'a', tmuxSession: 'ta' }), mkSession({ id: 'b', tmuxSession: 'tb' })];
    const h = harness({ sessions, cfg: { maxReapsPerHour: 1, maxReapsPerTick: 5 } });
    await driveToReap(h);
    // One reaped; the budget-gated one must NOT keep its reaping lease.
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.reaping.size).toBe(0); // both leases released — no permanent lockout
  });
});

describe('SessionReaper — robustness', () => {
  it('KEEPs (never reaps) when a protect-signal throws during evaluation', async () => {
    const h = harness({ deps: { isRecoveryActive: () => { throw new Error('boom'); } } });
    for (let i = 0; i < 4; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('snapshot never throws when a protect-signal throws', () => {
    const h = harness({ deps: { isRecoveryActive: () => { throw new Error('boom'); } } });
    const snap = h.reaper.snapshot();
    expect(snap.sessions[0].verdict).toBe('keep');
    expect(snap.sessions[0].keptBy).toBe('eval-error');
  });
});

describe('SessionReaper — observability', () => {
  it('snapshot reports per-session verdict + the gate that kept it', () => {
    const h = harness({ deps: { hasActiveProcesses: () => true } });
    const snap = h.reaper.snapshot();
    expect(snap.sessions[0].verdict).toBe('keep');
    expect(snap.sessions[0].keptBy).toBe('active-process');
    expect(snap.pressure.tier).toBe('critical');
  });
});
