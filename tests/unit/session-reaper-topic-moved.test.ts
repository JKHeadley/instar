/**
 * SessionReaper — post-transfer closeout rule (topicMovedCloseout).
 *
 * Operator-named issue (2026-06-05 topic 13481): "sessions don't get closed
 * off of a machine after the topic has moved from one machine to another,
 * which leaves duplicate sessions that do duplicate work."
 *
 * The rule: a topic-bound session whose topic is OWNED BY ANOTHER MACHINE
 * (per the session-pool ownership registry) is closed through the guarded
 * `terminate` authority after a confirm-tick dwell — independent of the idle
 * pipeline (a duplicate is wrong even when busy), but never a forced kill
 * (a KEEP-guard veto is audited and retried next tick).
 *
 * Both sides of every boundary: owned-elsewhere vs owned-by-self vs unowned,
 * dep absent (single-machine) → inert, dwell below/at threshold, dry-run →
 * would-reap audit only, guard veto → skip-audited + retried, budget caps.
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

// A WORKING frame: the idle pipeline would KEEP this session — proving the
// topic-moved rule acts independently of idleness.
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
  sessions?: Session[];
} = {}) {
  let now = 1_000_000;
  const sessions = opts.sessions ?? [mkSession()];
  const audits: Array<Record<string, unknown>> = [];
  const terminate = vi.fn(async () => ({ terminated: true }));
  const pressure: PressureReading = { tier: 'normal' }; // normal tier — idle pipeline OFF (normalTierReaps default false)

  const deps: SessionReaperDeps = {
    listRunningSessions: () => sessions.filter(s => s.status === 'running'),
    captureOutput: () => WORKING_FRAME,
    hasActiveProcesses: () => true, // would force KEEP in the idle pipeline
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
    ...opts.deps,
  };

  const cfg: Partial<SessionReaperConfig> = {
    enabled: true, dryRun: false, minAgeMinutes: 0,
    topicMovedCloseout: true, topicMovedConfirmTicks: 2,
    maxReapsPerTick: 3, maxReapsPerHour: 12,
    ...opts.cfg,
  };

  return {
    reaper: new SessionReaper(deps, cfg),
    terminate, audits,
    setNow: (n: number) => { now = n; },
  };
}

describe('SessionReaper — topic-moved closeout (post-transfer duplicate sessions)', () => {
  it('closes a session whose topic is owned by another machine after the confirm dwell — even while BUSY', async () => {
    const h = harness({ deps: { topicOwnerElsewhere: () => 'Laptop' } });
    await h.reaper.tick(); // streak 1 — below dwell, no kill yet
    expect(h.terminate).not.toHaveBeenCalled();
    h.setNow(1_120_000);
    await h.reaper.tick(); // streak 2 — dwell met → terminate
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.terminate.mock.calls[0][0]).toBe('s1');
    expect(String(h.terminate.mock.calls[0][1])).toContain('topic moved to Laptop');
    expect(h.audits.some(a => a.event === 'reaped' && (a as { rule?: string }).rule === 'topic-moved-away'
      || (a as { rule?: string }).rule === 'topic-moved-away')).toBe(true);
  });

  it('never fires for a topic owned by THIS machine (dep returns null)', async () => {
    const h = harness({ deps: { topicOwnerElsewhere: () => null } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('is inert when the dep is absent (single-machine / pool dark)', async () => {
    const h = harness({ deps: { topicOwnerElsewhere: undefined } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('is inert for sessions with no topic binding (job/headless sessions)', async () => {
    const h = harness({ deps: { topicBinding: () => null, topicOwnerElsewhere: () => 'Laptop' } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('ownership churn resets the dwell (no kill on a transient observation)', async () => {
    let owner: string | null = 'Laptop';
    const h = harness({ deps: { topicOwnerElsewhere: () => owner } });
    await h.reaper.tick();           // streak 1
    owner = null;                    // ownership came back mid-transfer
    h.setNow(1_120_000); await h.reaper.tick(); // streak resets
    owner = 'Laptop';
    h.setNow(1_240_000); await h.reaper.tick(); // streak 1 again — still below dwell
    expect(h.terminate).not.toHaveBeenCalled();
    h.setNow(1_360_000); await h.reaper.tick(); // streak 2 → fires
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });

  it('dry-run audits would-reap and never terminates', async () => {
    const h = harness({ cfg: { dryRun: true }, deps: { topicOwnerElsewhere: () => 'Laptop' } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    h.setNow(1_240_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.audits.some(a => (a as { rule?: string }).rule === 'topic-moved-away' && (a as { dryRun?: boolean }).dryRun === true)).toBe(true);
  });

  it('a guard veto (terminate skips) is audited and retried next tick', async () => {
    const terminate = vi.fn(async () => ({ terminated: false, skipped: 'active-process' }));
    const h = harness({ deps: { topicOwnerElsewhere: () => 'Laptop', terminate } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick(); // dwell met → attempt 1 (vetoed)
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(h.audits.some(a => (a as { skipped?: string }).skipped === 'active-process')).toBe(true);
    h.setNow(1_240_000); await h.reaper.tick(); // retried
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  it('the flag off disables the rule entirely', async () => {
    const h = harness({ cfg: { topicMovedCloseout: false }, deps: { topicOwnerElsewhere: () => 'Laptop' } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick();
    expect(h.terminate).not.toHaveBeenCalled();
  });

  // ── WS1.2 P19 breaker (MULTI-MACHINE-SEAMLESSNESS-SPEC) ────────────────────
  // The spec's required sustained-failure test: a permanently-vetoing session
  // gets BOUNDED attempts + exactly ONE escalation — the 2026-06-12 incident
  // (closeout attacking a working session every 2 minutes for hours) becomes
  // impossible by construction.

  it('P19 breaker: a permanently-vetoing session gets exactly N attempts, then retries stop', async () => {
    const terminate = vi.fn(async () => ({ terminated: false, skipped: 'active-process' }));
    const raiseAttention = vi.fn();
    const h = harness({
      cfg: { topicMovedVetoBreakerAttempts: 3 },
      deps: { topicOwnerElsewhere: () => 'Laptop', terminate, raiseAttention },
    });
    // Run far past the threshold — 10 ticks.
    for (let i = 0; i < 10; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    // Dwell eats tick 1; attempts on ticks 2,3,4; breaker open from tick 5 on.
    expect(terminate).toHaveBeenCalledTimes(3);
    // Exactly ONE breaker-open audit and ONE escalation.
    expect(h.audits.filter(a => a.event === 'closeout-breaker-open')).toHaveLength(1);
    expect(raiseAttention).toHaveBeenCalledTimes(1);
    const item = raiseAttention.mock.calls[0][0] as { id: string; title: string; description?: string };
    expect(item.id).toBe('closeout-breaker:s1'); // stable id — attention store dedupes on it
    expect(item.title).toContain('Laptop');
    expect(String(item.description)).toContain('active-process');
  });

  it('P19 breaker: topic returning home resets the episode — a future genuine move retries fresh', async () => {
    let owner: string | null = 'Laptop';
    const terminate = vi.fn(async () => ({ terminated: false, skipped: 'active-process' }));
    const raiseAttention = vi.fn();
    const h = harness({
      cfg: { topicMovedVetoBreakerAttempts: 2 },
      deps: { topicOwnerElsewhere: () => owner, terminate, raiseAttention },
    });
    let t = 1_000_000;
    const tick = async () => { h.setNow(t); t += 120_000; await h.reaper.tick(); };
    await tick(); await tick(); await tick(); // dwell + 2 vetoed attempts → breaker open
    expect(terminate).toHaveBeenCalledTimes(2);
    await tick();                              // breaker open — no attempt
    expect(terminate).toHaveBeenCalledTimes(2);
    owner = null; await tick();                // topic home — episode resets
    owner = 'Laptop'; await tick(); await tick(); // fresh dwell + attempt
    expect(terminate).toHaveBeenCalledTimes(3);
  });

  it('P19 breaker: a successful close before the threshold clears the veto counter', async () => {
    let veto = true;
    const terminate = vi.fn(async () => (veto ? { terminated: false, skipped: 'active-process' } : { terminated: true }));
    const raiseAttention = vi.fn();
    const h = harness({
      cfg: { topicMovedVetoBreakerAttempts: 3 },
      deps: { topicOwnerElsewhere: () => 'Laptop', terminate, raiseAttention },
    });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick(); // vetoed attempt 1
    h.setNow(1_240_000); veto = false; await h.reaper.tick(); // succeeds
    expect(h.audits.some(a => a.event === 'reaped')).toBe(true);
    expect(raiseAttention).not.toHaveBeenCalled(); // breaker never opened
  });

  it('P19 breaker: pin-conflict hold withdraws the closeout intent and clears the counter', async () => {
    let pinned = false;
    const terminate = vi.fn(async () => ({ terminated: false, skipped: 'active-process' }));
    const raiseAttention = vi.fn();
    const h = harness({
      cfg: { topicMovedVetoBreakerAttempts: 2 },
      deps: { topicOwnerElsewhere: () => 'Laptop', topicPinnedHere: () => pinned, terminate, raiseAttention },
    });
    let t = 1_000_000;
    const tick = async () => { h.setNow(t); t += 120_000; await h.reaper.tick(); };
    await tick(); await tick();        // dwell + vetoed attempt 1 (one below threshold)
    expect(terminate).toHaveBeenCalledTimes(1);
    pinned = true; await tick();       // pin-conflict hold — counter cleared (streak parked at -1)
    // The -1 sentinel climbs back through 0 → fresh dwell takes 3 ticks, then 2 attempts.
    pinned = false; await tick(); await tick(); await tick(); await tick();
    expect(terminate).toHaveBeenCalledTimes(3); // 1 + the fresh episode's 2 — counter genuinely reset
    expect(raiseAttention).toHaveBeenCalledTimes(1); // breaker opened only in the second episode
  });

  it('P19 breaker: absent raiseAttention dep is audit-only (no crash)', async () => {
    const terminate = vi.fn(async () => ({ terminated: false, skipped: 'active-process' }));
    const h = harness({
      cfg: { topicMovedVetoBreakerAttempts: 2 },
      deps: { topicOwnerElsewhere: () => 'Laptop', terminate, raiseAttention: undefined },
    });
    for (let i = 0; i < 5; i++) { h.setNow(1_000_000 + i * 120_000); await h.reaper.tick(); }
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(h.audits.filter(a => a.event === 'closeout-breaker-open')).toHaveLength(1);
  });

  it('respects maxReapsPerTick across multiple moved topics', async () => {
    const sessions = [
      mkSession({ id: 's1', tmuxSession: 't1' }),
      mkSession({ id: 's2', tmuxSession: 't2' }),
      mkSession({ id: 's3', tmuxSession: 't3' }),
    ];
    const h = harness({
      cfg: { maxReapsPerTick: 1 },
      sessions,
      deps: {
        topicBinding: (t) => ({ t1: 1, t2: 2, t3: 3 }[t] ?? null),
        topicOwnerElsewhere: () => 'Laptop',
      },
    });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick(); // dwell met for all 3 — only 1 closes this tick
    expect(h.terminate).toHaveBeenCalledTimes(1);
    h.setNow(1_240_000); await h.reaper.tick(); // next tick closes another
    expect(h.terminate).toHaveBeenCalledTimes(2);
  });

  // ── F8 lease carve-out (roadmap 0.6, test-as-self 2026-07-02) ─────────────
  // The machine a topic moves AWAY from is by definition usually NOT the
  // serving-lease holder, so the authority's lease gate structurally vetoed
  // the exact closeout the transfer requires (skipped:'not-lease-holder' ×5,
  // then breaker give-up — the leftover session survived). Every closeout
  // terminate must therefore carry the narrow lease bypass.

  it('F8: the closeout terminate carries bypassLeaseForTopicMovedCloseout (legacy path)', async () => {
    const h = harness({ deps: { topicOwnerElsewhere: () => 'Mac Mini' } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick(); // dwell met → terminate
    expect(h.terminate).toHaveBeenCalledTimes(1);
    const opts = h.terminate.mock.calls[0][2] as {
      bypassLeaseForTopicMovedCloseout?: boolean;
      bypassRecentUserMessageForConfirmedMove?: boolean;
      workEvidence?: string[];
    } | undefined;
    expect(opts?.bypassLeaseForTopicMovedCloseout).toBe(true);
    // The legacy path never mints the Part E recent-message bypass, and it
    // leaves workEvidence unset so the authority's guard-collected fallback
    // is preserved (F8 lifts ONLY the lease gate — nothing else changes).
    expect(opts?.bypassRecentUserMessageForConfirmedMove).toBeUndefined();
    expect(opts?.workEvidence).toBeUndefined();
  });

  it('F8: a lease-vetoing authority closes the leftover once the bypass is honored (regression shape of the audit)', async () => {
    // Model the audited failure: an authority that refuses any closeout
    // WITHOUT the lease bypass (the old machine is not the lease holder), but
    // honors the carve-out. Pre-fix, the reaper passed no flag → 5 vetoes →
    // breaker give-up; with the fix the FIRST attempt lands.
    const terminate = vi.fn(async (_id: string, _r: string, opts?: { bypassLeaseForTopicMovedCloseout?: boolean }) =>
      opts?.bypassLeaseForTopicMovedCloseout ? { terminated: true } : { terminated: false, skipped: 'not-lease-holder' });
    const raiseAttention = vi.fn();
    const h = harness({ deps: { topicOwnerElsewhere: () => 'Mac Mini', terminate, raiseAttention } });
    await h.reaper.tick();
    h.setNow(1_120_000); await h.reaper.tick(); // dwell met → attempt 1 succeeds
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(h.audits.some(a => a.event === 'reaped' && (a as { rule?: string }).rule === 'topic-moved-away')).toBe(true);
    // No veto streak, no breaker, no escalation — the leftover is gone.
    expect(h.audits.filter(a => a.event === 'closeout-breaker-open')).toHaveLength(0);
    expect(raiseAttention).not.toHaveBeenCalled();
  });
});
