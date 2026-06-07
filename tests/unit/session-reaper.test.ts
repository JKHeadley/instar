/**
 * SessionReaper — the safety-critical classifier. THE hard requirement under
 * test: NEVER reap a working session. Every protect-gate, the positive-idle
 * requirement, the confidence contract (unresolved → KEEP), render-stasis,
 * hysteresis, pressure tiers, the two-phase reap, dry-run, and the bounded
 * blast radius + auto-disable.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
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
    // Open commitment keeps only while a message is within the staleness window (24h)
    // but outside the 30min recent-user window — a window-aware mock distinguishes them.
    ['open commitment', { topicBinding: () => 42, activeCommitmentForTopic: () => true, recentUserMessage: (_t, withinMs) => withinMs > 60 * 60_000 }, 'open-commitment'],
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

describe('SessionReaper — stale-idle active-process override (reapStaleIdleWithActiveChildren)', () => {
  // A 24h-silent session whose ONLY "activity" is idle children (e.g. idle MCP servers)
  // is abandoned: relax the active-process veto, but it STILL must be positively idle +
  // transcript-flat to reap. The active-process analogue of the #955 stale-commitment override.
  const staleIdleDeps = {
    topicBinding: () => 42,
    recentUserMessage: () => false, // no message in any window ⇒ stale-idle
    hasActiveProcesses: () => true, // idle MCP children keep it "active"
  };

  it('REAPS a stale-idle session held only by idle children (and flags staleIdleRelaxed)', () => {
    const h = harness({ deps: staleIdleDeps });
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('reap-eligible');
    expect(e.staleIdleRelaxed).toBe(true);
  });

  it('KEEPs on active-process when the session is NOT stale (message within the window)', () => {
    // Active within 24h (not 30min) ⇒ not stale ⇒ veto stands. (Window-aware mock so the
    // 30min recent-user guard doesn't pre-empt with recent-user-message.)
    const h = harness({ deps: { topicBinding: () => 42, hasActiveProcesses: () => true, recentUserMessage: (_t, withinMs) => withinMs > 60 * 60_000 } });
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('keep');
    expect(e.keptBy).toBe('active-process');
  });

  it('does NOT relax when reapStaleIdleWithActiveChildren is off (old conservative behavior)', () => {
    const h = harness({ cfg: { reapStaleIdleWithActiveChildren: false }, deps: staleIdleDeps });
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('keep');
    expect(e.keptBy).toBe('active-process');
  });

  it('STILL keeps a stale-idle session that is not positively idle (safety holds after relax)', () => {
    const h = harness({ deps: staleIdleDeps });
    h.setFrame(WORKING_FRAME); // pane shows work in progress, not a ready prompt
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('keep');
    expect(e.keptBy).toBe('no-positive-idle');
  });

  it('does NOT relax a stale-idle session with NO bound topic (cannot time-bound ⇒ conservative)', () => {
    const h = harness({ deps: { topicBinding: () => null, recentUserMessage: () => false, hasActiveProcesses: () => true } });
    const e = h.reaper.evaluate(mkSession());
    expect(e.verdict).toBe('keep');
    expect(e.keptBy).toBe('active-process');
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
    // The shared ReapGuard (§P2) catches a throwing stateless signal internally and
    // resolves it to a KEEP ('guard-error') — safe-by-default for every killer that
    // calls the guard. The KEEP-never-reap intent is unchanged (asserted above); only
    // the diagnostic label moved from the reaper's outer catch ('eval-error', still
    // live for a throw in the stateful transcript/idle checks) to the guard's.
    expect(snap.sessions[0].keptBy).toBe('guard-error');
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

describe('SessionReaper.probe fallback resolves the transcript via session.projectDir', () => {
  // The production reaper has NO injected deps.probeTranscript, so it uses the fallback
  // probe(). That fallback passed projectDir:'' → the transcript path resolved to an
  // empty-encoded dir that never exists → EVERY session read transcript-unresolved →
  // the reaper could never prove idle. Fix: pass session.projectDir. (deps.probeTranscript
  // is set undefined here so the harness exposes the real fallback.)
  function withHome(home: string, fn: () => void): void {
    const orig = process.env.HOME;
    process.env.HOME = home;
    try { fn(); } finally { if (orig === undefined) delete process.env.HOME; else process.env.HOME = orig; }
  }

  it('resolves when transcriptProjectDir is wired (the projectDir:"" fix)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-probe-'));
    withHome(home, () => {
      const projectDir = '/tmp/proj/x';
      const encoded = projectDir.replace(/[/.]/g, '-'); // Claude Code's cwd encoding
      const dir = path.join(home, '.claude', 'projects', encoded);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'c1.jsonl'), '{"t":1}\n');
      const h = harness({ deps: { probeTranscript: undefined, hasActiveProcesses: () => false, transcriptProjectDir: () => projectDir } });
      const e = h.reaper.evaluate(mkSession({ claudeSessionId: 'c1' }));
      // Transcript now RESOLVES (file exists) → it is NOT kept as transcript-unresolved;
      // with an idle frame it proceeds all the way to reap-eligible.
      expect(e.keptBy).not.toBe('transcript-unresolved');
      expect(e.verdict).toBe('reap-eligible');
    });
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/session-reaper.test.ts' });
  });

  it('stays transcript-unresolved (KEEP) when transcriptProjectDir is absent — the old broken path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-probe-none-'));
    withHome(home, () => {
      const h = harness({ deps: { probeTranscript: undefined, hasActiveProcesses: () => false } });
      const e = h.reaper.evaluate(mkSession({ claudeSessionId: 'no-such-transcript' }));
      expect(e.verdict).toBe('keep');
      expect(e.keptBy).toBe('transcript-unresolved');
    });
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/session-reaper.test.ts' });
  });
});

describe('SessionReaper.isPositivelyIdle — live markers vs scrollback (2026-06-07 bug)', () => {
  // An IDLE Claude pane: its scrollback is full of PAST tool-names + the word
  // "claude", and the footer shows the ready-prompt — but NO live spinner/esc. This
  // is the case that mis-read as "working" (toolCallOrSpinner matched the scrollback),
  // so the reaper never reaped. It MUST now read as positively idle.
  const IDLE_CLAUDE = [
    'Read(src/foo.ts)',
    'Bash(npm test)  ⎿ ok',
    'claude finished the task; nothing pending.',
    '✻ Cooked for 7m 8s · 1 shell still running',
    '❯ ',
    '⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage   new task? /clear to save 193.3k tokens',
  ].join('\n');

  it('idle Claude pane (scrollback tool-names + "claude", no live marker) → positively idle', () => {
    expect(SessionReaper.isPositivelyIdle('claude-code', IDLE_CLAUDE)).toBe(true);
  });

  it('working Claude pane (live spinner) → NOT idle', () => {
    const working = 'Bash(npm test)\n⠹ Crunching the numbers…\nesc to interrupt';
    expect(SessionReaper.isPositivelyIdle('claude-code', working)).toBe(false);
  });

  it('working Claude pane (spinner glyph only, no esc) → NOT idle', () => {
    const spinning = 'Read(x.ts)\nbypass permissions on\n⠼ generating';
    expect(SessionReaper.isPositivelyIdle('claude-code', spinning)).toBe(false);
  });

  it('the bare word "claude" alone no longer forces NOT-idle (the removed false match)', () => {
    // Ready-prompt present, "claude" in scrollback, no live marker → idle.
    expect(SessionReaper.isPositivelyIdle('claude-code', 'claude\nbypass permissions on\n❯ ')).toBe(true);
  });
});

describe('SessionReaper — durable candidacy (A): idle clock survives restarts', () => {
  it('persists the candidacy map after each tick (saveCandidacy)', async () => {
    let saved: Record<string, unknown> | null = null;
    const h = harness({ deps: { saveCandidacy: (m) => { saved = { ...m }; } } });
    await h.reaper.tick();
    expect(saved).not.toBeNull();
    expect(Object.keys(saved as object).length).toBeGreaterThan(0); // the candidate session was persisted
  });

  it('restored candidacy lets a long-idle session reap immediately (clock survived the restart)', async () => {
    const now = 1_000_000;
    const old = now - 60 * 60_000; // idle 60 min — already past a 30-min threshold
    const loaded = { s1: { candidateSince: old, consecutive: 5, lastFrame: IDLE_FRAME, lastTranscript: RESOLVED_STATIC } };
    const h = harness({ cfg: { idleThresholdCriticalMinutes: 30, confirmObservations: 2, finalGraceSec: 1 }, deps: { loadCandidacy: () => loaded } });
    h.setNow(now); await h.reaper.tick();            // frameStatic → candidateSince preserved (60min>30) + consecutive 6 → reap-pending
    h.setNow(now + 2000); await h.reaper.tick();      // grace (1s) elapsed → terminate
    expect(h.terminate).toHaveBeenCalledWith('s1', expect.any(String));
  });

  it('a FRESH reaper (no restore) would NOT reap that session yet — proving the restore mattered', async () => {
    const now = 1_000_000;
    const h = harness({ cfg: { idleThresholdCriticalMinutes: 30, confirmObservations: 2, finalGraceSec: 1 } });
    h.setNow(now); await h.reaper.tick();             // candidateSince = now (idle 0 < 30min)
    h.setNow(now + 2000); await h.reaper.tick();      // still far below the 30-min threshold
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('drops reapPendingSince on load — no insta-kill from a stale "about to reap" state', async () => {
    const now = 1_000_000;
    const loaded = { s1: { candidateSince: now - 60 * 60_000, consecutive: 5, lastFrame: IDLE_FRAME, lastTranscript: RESOLVED_STATIC, reapPendingSince: now - 60 * 60_000 } };
    // Long grace so a KEPT reapPendingSince would have terminated on tick 1; a DROPPED one re-enters pending and waits.
    const h = harness({ cfg: { idleThresholdCriticalMinutes: 30, confirmObservations: 2, finalGraceSec: 600 }, deps: { loadCandidacy: () => loaded } });
    h.setNow(now); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled(); // stale pending was dropped → fresh two-phase, grace not yet elapsed
  });
});
