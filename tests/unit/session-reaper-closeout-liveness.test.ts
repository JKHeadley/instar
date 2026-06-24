/**
 * SessionReaper — post-transfer closeout CORRECTNESS gate (closeoutLivenessGate).
 *
 * Spec: docs/specs/post-transfer-closeout-correctness.md.
 *
 * The bug: the closeout terminated the LIVE local session for a topic when the
 * local ownership record was STALE — nothing verified the remote owner actually
 * had a live session. The fix: gate the closeout on `remoteOwnerHasLiveSession`.
 *   true     → genuine move (real duplicate) → proceed (dwell → terminate, Part E bypass).
 *   false    → owner has NO live session → WITHHOLD (never kill the sole worker).
 *   'unknown'→ undeterminable → WITHHOLD (fail-closed; the inverse of the bug).
 *
 * Both sides of EVERY boundary: true / false / unknown / dep-throws / dep-absent /
 * gate-OFF regression-lock; the freshest-interaction Part E veto (both sides); the
 * pin-conflict still wins; the topic-keyed breaker counter across session-id churn;
 * the -1→true transition; the double-local-binding pathological case.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SessionReaper,
  type SessionReaperDeps,
  type SessionReaperConfig,
  type PressureReading,
} from '../../src/monitoring/SessionReaper.js';
import type { Session } from '../../src/core/types.js';
import type { TranscriptProbe } from '../../src/monitoring/transcriptProber.js';

const WORKING_FRAME = 'esc to interrupt\nWorking...';
const RESOLVED_STATIC: TranscriptProbe = { resolved: true, path: '/t.jsonl', size: 100, mtime: 1000 };

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'sess', status: 'running', tmuxSession: 't1',
    startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    ...over,
  };
}

/** A liveness dep whose answer can be flipped per test, with an advancing
 *  reachableAt so the dwell-advancement requirement is satisfied across ticks. */
function liveness(state: boolean | 'unknown', getReachableAt: () => number) {
  return vi.fn((_topicId: number, _machine: string) =>
    state === 'unknown' ? { state: 'unknown' as const } : { state, reachableAt: getReachableAt() });
}

function harness(opts: {
  cfg?: Partial<SessionReaperConfig>;
  deps?: Partial<SessionReaperDeps>;
  sessions?: Session[];
} = {}) {
  let now = 1_000_000;
  const sessions = opts.sessions ?? [mkSession()];
  const audits: Array<Record<string, unknown>> = [];
  const terminate = vi.fn(async (_id: string, _r: string, _o?: unknown) => ({ terminated: true }));
  const pressure: PressureReading = { tier: 'normal' };

  const deps: SessionReaperDeps = {
    listRunningSessions: () => sessions.filter(s => s.status === 'running'),
    captureOutput: () => WORKING_FRAME,
    hasActiveProcesses: () => true,
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => RESOLVED_STATIC,
    isRecoveryActive: () => false,
    isRelayLeaseActive: () => false,
    hasPendingInjection: () => false,
    topicBinding: () => 13481,
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
    // gated-path owner read (atomic machineId + display)
    topicOwnerElsewhereInfo: () => ({ machineId: 'mac-mini-abc', displayName: 'Mac Mini' }),
    ...opts.deps,
  };

  const cfg: Partial<SessionReaperConfig> = {
    enabled: true, dryRun: false, minAgeMinutes: 0,
    topicMovedCloseout: true, topicMovedConfirmTicks: 2,
    closeoutLivenessGate: true,
    maxReapsPerTick: 3, maxReapsPerHour: 12,
    ...opts.cfg,
  };

  return {
    reaper: new SessionReaper(deps, cfg),
    terminate, audits,
    setNow: (n: number) => { now = n; },
  };
}

describe('SessionReaper — closeout liveness gate (Part C decision table)', () => {
  it('remoteOwnerHasLiveSession=true → genuine move → terminate after the dwell', async () => {
    let r = 500_000;
    const h = harness({ deps: { remoteOwnerHasLiveSession: liveness(true, () => r) } });
    await h.reaper.tick();                       // dwell count 1
    expect(h.terminate).not.toHaveBeenCalled();
    h.setNow(1_120_000); r = 700_000;            // ADVANCED snapshot generation
    await h.reaper.tick();                        // dwell count 2 → terminate
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.audits.some(a => a.event === 'reaped' && (a as any).confirmedMove === true)).toBe(true);
  });

  it('remoteOwnerHasLiveSession=false → WITHHOLD; no terminate; once-per-episode stale-owner audit', async () => {
    const h = harness({ deps: { remoteOwnerHasLiveSession: liveness(false, () => 500_000) } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
    const skips = h.audits.filter(a => (a as any).skipped === 'no-live-remote-session');
    expect(skips).toHaveLength(1); // once-per-episode (held sentinel)
    expect((skips[0] as any).possibleStaleOwner).toBe(true);
    expect((skips[0] as any).remoteOwnerListedSession).toBe(false);
    expect((skips[0] as any).withheldCloseout).toBe(true);
    // NEUTRAL / non-directional — no reconcileToward field.
    expect('reconcileToward' in (skips[0] as any)).toBe(false);
  });

  // THE single most important test — the inverse of the bug.
  it('remoteOwnerHasLiveSession=\'unknown\' → WITHHOLD (fail-closed)', async () => {
    const h = harness({ deps: { remoteOwnerHasLiveSession: liveness('unknown', () => 0) } });
    for (let i = 0; i < 4; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.audits.some(a => (a as any).skipped === 'remote-liveness-unknown')).toBe(true);
  });

  it('liveness dep THROWS → treated as unknown → WITHHOLD', async () => {
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const h = harness({ deps: { remoteOwnerHasLiveSession: throwing as any } });
    for (let i = 0; i < 3; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.audits.some(a => (a as any).skipped === 'remote-liveness-unknown')).toBe(true);
  });

  it('liveness dep ABSENT while gate ON → WITHHOLD (fail-closed)', async () => {
    const h = harness({ deps: { remoteOwnerHasLiveSession: undefined } });
    for (let i = 0; i < 3; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('topicOwnerElsewhereInfo ABSENT under the gate → no fallback to display-only → WITHHOLD', async () => {
    const h = harness({ deps: { topicOwnerElsewhereInfo: undefined, remoteOwnerHasLiveSession: liveness(true, () => 9) } });
    for (let i = 0; i < 3; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('gate OFF → byte-identical legacy: terminates on owned-elsewhere WITHOUT consulting liveness', async () => {
    const live = liveness(false, () => 1); // would WITHHOLD if consulted
    const h = harness({
      cfg: { closeoutLivenessGate: false },
      deps: { topicOwnerElsewhere: () => 'Mac Mini', remoteOwnerHasLiveSession: live },
    });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(live).not.toHaveBeenCalled(); // liveness never consulted on the OFF path
  });

  it('pin-conflict STILL wins ahead of the liveness gate (regardless of liveness)', async () => {
    const live = liveness(true, () => 9);
    const h = harness({ deps: { topicPinnedHere: () => true, remoteOwnerHasLiveSession: live } });
    for (let i = 0; i < 4; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.audits.some(a => (a as any).skipped === 'pin-conflict-pending-reconcile')).toBe(true);
  });

  it('dwell does NOT advance on a re-read of the SAME snapshot generation', async () => {
    const h = harness({ deps: { remoteOwnerHasLiveSession: liveness(true, () => 500_000) } }); // reachableAt never advances
    for (let i = 0; i < 5; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled(); // count stuck at 1 — never reaches confirmTicks
  });

  it('an alternating true→unknown→true sequence resets the streak (no false accrual)', async () => {
    let state: boolean | 'unknown' = true;
    let r = 100_000;
    const dyn = vi.fn(() => state === 'unknown' ? { state: 'unknown' as const } : { state, reachableAt: (r += 100_000) });
    const h = harness({ deps: { remoteOwnerHasLiveSession: dyn as any } });
    await h.reaper.tick();                 // true: count 1
    state = 'unknown';
    h.setNow(1_120_000); await h.reaper.tick(); // unknown: reset
    state = true;
    h.setNow(1_240_000); await h.reaper.tick(); // true: count 1 again
    expect(h.terminate).not.toHaveBeenCalled();
    h.setNow(1_360_000); await h.reaper.tick(); // true: count 2 → fires
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('SessionReaper — Part E freshest-interaction veto (both sides)', () => {
  it('confirmed move + last user message OLDER than the snapshot → bypass PASSED, leftover sheds', async () => {
    let r = 500_000;
    const h = harness({
      deps: {
        remoteOwnerHasLiveSession: liveness(true, () => r),
        recentUserMessageAt: () => 400_000, // older than the snapshot reachableAt
      },
    });
    await h.reaper.tick();
    h.setNow(1_120_000); r = 700_000; await h.reaper.tick();
    expect(h.terminate).toHaveBeenCalledTimes(1);
    const opts = h.terminate.mock.calls[0][2] as any;
    expect(opts?.bypassRecentUserMessageForConfirmedMove).toBe(true);
  });

  it('confirmed move BUT a user message NEWER than the snapshot → bypass WITHHELD (session kept by recent-user-message)', async () => {
    let r = 500_000;
    // terminate is vetoed by recent-user-message because the bypass is NOT passed.
    const terminate = vi.fn(async (_id: string, _reason: string, opts?: any) =>
      opts?.bypassRecentUserMessageForConfirmedMove ? { terminated: true } : { terminated: false, skipped: 'recent-user-message' });
    const h = harness({
      deps: {
        terminate,
        remoteOwnerHasLiveSession: liveness(true, () => r),
        recentUserMessageAt: () => 9_000_000, // NEWER than the snapshot → bypass withheld
      },
    });
    await h.reaper.tick();
    h.setNow(1_120_000); r = 700_000; await h.reaper.tick();
    expect(terminate).toHaveBeenCalledTimes(1);
    const opts = terminate.mock.calls[0][2];
    expect(opts?.bypassRecentUserMessageForConfirmedMove).toBeUndefined();
    // The session is kept (vetoed) — never terminated this tick.
    await expect(terminate.mock.results[0].value).resolves.toMatchObject({ terminated: false });
  });

  it('false / unknown → terminate NEVER called → the bypass is never passed', async () => {
    const h = harness({ deps: { remoteOwnerHasLiveSession: liveness(false, () => 1), recentUserMessageAt: () => 1 } });
    for (let i = 0; i < 4; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(h.terminate).not.toHaveBeenCalled();
  });
});

describe('SessionReaper — Secondary: breaker counter stability + episode hygiene (topic-keyed)', () => {
  it('a session respawn under a NEW id but the SAME topic PRESERVES the veto count within one episode', async () => {
    const terminate = vi.fn(async () => ({ terminated: false, skipped: 'active-process' }));
    let r = 100_000;
    const session = mkSession({ id: 's1', tmuxSession: 't1' });
    const sessions = [session];
    const h = harness({
      cfg: { topicMovedVetoBreakerAttempts: 3 },
      sessions,
      deps: {
        terminate,
        topicBinding: () => 42,
        topicOwnerElsewhereInfo: () => ({ machineId: 'm', displayName: 'M' }),
        remoteOwnerHasLiveSession: liveness(true, () => (r += 100_000)),
      },
    });
    // Build two vetoed attempts on s1.
    h.setNow(1_000_000); await h.reaper.tick(); // dwell 1
    h.setNow(1_120_000); await h.reaper.tick(); // dwell 2 → vetoed attempt 1
    expect(terminate).toHaveBeenCalledTimes(1);
    // Respawn under a NEW id, SAME topic (42).
    sessions[0] = mkSession({ id: 's2', tmuxSession: 't1' });
    h.setNow(1_240_000); await h.reaper.tick(); // dwell continues (topic-keyed) → vetoed attempt 2
    h.setNow(1_360_000); await h.reaper.tick(); // vetoed attempt 3 → breaker opens
    // 3 attempts total across the id churn — the count did NOT reset on respawn.
    expect(terminate).toHaveBeenCalledTimes(3);
    expect(h.audits.filter(a => a.event === 'closeout-breaker-open')).toHaveLength(1);
  });

  it('the topic returning home BETWEEN episodes clears the topic-keyed count', async () => {
    const terminate = vi.fn(async () => ({ terminated: false, skipped: 'active-process' }));
    let owned = true;
    let r = 100_000;
    const h = harness({
      cfg: { topicMovedVetoBreakerAttempts: 2 },
      deps: {
        terminate,
        topicOwnerElsewhereInfo: () => owned ? ({ machineId: 'm', displayName: 'M' }) : null,
        remoteOwnerHasLiveSession: liveness(true, () => (r += 100_000)),
      },
    });
    let t = 1_000_000; const tick = async () => { h.setNow(t); t += 120_000; await h.reaper.tick(); };
    await tick(); await tick(); // dwell + vetoed attempt 1 (one below threshold)
    expect(terminate).toHaveBeenCalledTimes(1);
    owned = false; await tick(); // topic home — episode resets, count cleared
    owned = true;
    await tick(); await tick(); await tick(); // fresh dwell + 2 attempts (breaker opens fresh)
    expect(terminate).toHaveBeenCalledTimes(3); // 1 + 2 fresh — the stale count did NOT carry
  });

  it('a held (-1) entry that next reads true REPLACES the hold with a fresh dwell starting at 1 (no head start)', async () => {
    let state: boolean | 'unknown' = false; // first episode WITHHELD (held sentinel)
    let r = 100_000;
    const dyn = vi.fn(() => state === 'unknown' ? { state: 'unknown' as const } : { state, reachableAt: (r += 100_000) });
    const h = harness({ deps: { remoteOwnerHasLiveSession: dyn as any } });
    await h.reaper.tick();                 // false → held
    h.setNow(1_120_000); await h.reaper.tick(); // still false → still held (no new audit)
    expect(h.audits.filter(a => (a as any).skipped === 'no-live-remote-session')).toHaveLength(1);
    state = true;
    h.setNow(1_240_000); await h.reaper.tick(); // -1 → true: fresh count 1 (no head start)
    expect(h.terminate).not.toHaveBeenCalled(); // count 1, below confirmTicks 2
    h.setNow(1_360_000); await h.reaper.tick(); // count 2 → fires
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });

  it('double-local-binding pathological case: shared topic-keyed counter is conservative (no wrong kill)', async () => {
    // Two local sessions bound to the SAME topic (a Part-D pathology, not introduced here).
    const terminate = vi.fn(async () => ({ terminated: false, skipped: 'active-process' }));
    const sessions = [mkSession({ id: 'a', tmuxSession: 'ta' }), mkSession({ id: 'b', tmuxSession: 'tb' })];
    let r = 100_000;
    const h = harness({
      cfg: { topicMovedVetoBreakerAttempts: 4 },
      sessions,
      deps: {
        terminate,
        topicBinding: () => 7, // BOTH bound to topic 7
        topicOwnerElsewhereInfo: () => ({ machineId: 'm', displayName: 'M' }),
        remoteOwnerHasLiveSession: liveness(true, () => (r += 100_000)),
      },
    });
    for (let i = 0; i < 4; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    // Every terminate was vetoed → no session killed. The shared counter only ever
    // opens the breaker SOONER (the safe direction), never permits a wrong kill.
    expect(terminate.mock.results.every(r => (r.value as any))).toBe(true);
    // (all returned the vetoed shape; no terminated:true) — assert no reaped audit.
    expect(h.audits.some(a => a.event === 'reaped')).toBe(false);
  });
});
