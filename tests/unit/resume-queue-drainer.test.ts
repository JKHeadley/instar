// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * ResumeQueueDrainer (reap-notify spec R2.4–R2.11) — calm-ticks, one-per-tick,
 * re-entrancy, EACH drain-time validation both sides, pause semantics, the
 * failure ladder + breaker, dry-run inertness, Tier1 observe-only paths, and
 * the oscillating-load calm-ticks reset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ResumeQueue, type ResumeCandidateInput } from '../../src/monitoring/ResumeQueue.js';
import {
  ResumeQueueDrainer,
  type ResumeQueueDrainerDeps,
} from '../../src/monitoring/ResumeQueueDrainer.js';
import {
  AGE_LIMIT_ACTIVE_RUN_REASON,
  COMMITMENT_ACTIVE_RUN_REASON,
  isAutoResumableEmergencyPauseReason,
} from '../../src/core/WorkEvidence.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-drainer-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function candidate(over: Partial<ResumeCandidateInput> = {}): ResumeCandidateInput {
  return {
    sessionName: 'sess',
    tmuxSession: 'tmux-1',
    topicId: 42,
    resumeUuid: '11111111-1111-4111-8111-111111111111',
    cwd: '/tmp/project',
    reason: 'quota-shed',
    disposition: 'terminal',
    origin: 'autonomous',
    workEvidence: ['build-or-autonomous-active'],
    ...over,
  };
}

interface Harness {
  queue: ResumeQueue;
  drainer: ResumeQueueDrainer;
  deps: ResumeQueueDrainerDeps;
  audits: Array<Record<string, unknown>>;
  aggregated: Array<{ kind: string; detail: string }>;
  respawns: string[];
  notices: string[];
  setTier: (t: 'normal' | 'moderate' | 'critical') => void;
  advance: (ms: number) => void;
}

function harness(over?: {
  queueCfg?: Partial<import('../../src/monitoring/ResumeQueue.js').ResumeQueueConfig>;
  drainerCfg?: Partial<import('../../src/monitoring/ResumeQueueDrainer.js').ResumeQueueDrainerConfig>;
  deps?: Partial<ResumeQueueDrainerDeps>;
}): Harness {
  const audits: Array<Record<string, unknown>> = [];
  const aggregated: Array<{ kind: string; detail: string }> = [];
  const respawns: string[] = [];
  const notices: string[] = [];
  let nowMs = 4_000_000_000_000;
  let tier: 'normal' | 'moderate' | 'critical' = 'normal';
  const queue = new ResumeQueue(
    {
      stateDir: tmpDir,
      audit: (e) => audits.push(e),
      raiseAggregated: (kind, detail) => aggregated.push({ kind, detail }),
      now: () => nowMs,
    },
    { dryRun: false, ...over?.queueCfg },
  );
  queue.start();
  const deps: ResumeQueueDrainerDeps = {
    queue,
    pressureTier: () => tier,
    canSpawnSession: () => true,
    sessionCountOk: () => true,
    migrationInFlight: () => false,
    liveSessionForTopic: () => false,
    currentResumeUuid: () => '11111111-1111-4111-8111-111111111111',
    topicOwnerElsewhere: () => false,
    topicBindingMatches: () => true,
    operatorStopSince: () => false,
    jobCheck: () => ({ ok: true }),
    pathExists: () => true,
    respawnTopic: async (entry) => {
      respawns.push(entry.id);
      return `respawned-${entry.tmuxSession}`;
    },
    triggerJob: async () => 'triggered',
    spawnAliveAfterGrace: async () => true,
    notifyResumed: (entry) => notices.push(entry.id),
    raiseAggregated: (kind, detail) => aggregated.push({ kind, detail }),
    audit: (e) => audits.push(e),
    now: () => nowMs,
    ...over?.deps,
  };
  const drainer = new ResumeQueueDrainer(deps, {
    requiredCalmTicks: 3,
    attemptBackoffMs: 1000,
    ...over?.drainerCfg,
  });
  return {
    queue,
    drainer,
    deps,
    audits,
    aggregated,
    respawns,
    notices,
    setTier: (t) => { tier = t; },
    advance: (ms) => { nowMs += ms; },
  };
}

/** Drive enough calm ticks to satisfy the gate. */
async function warmCalm(h: Harness, ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) await h.drainer.tick();
}

describe('ResumeQueueDrainer — calm gates (R2.4)', () => {
  it('does not resume until requiredCalmTicks consecutive normal ticks', async () => {
    const h = harness();
    h.queue.considerEnqueue(candidate());
    expect((await h.drainer.tick()).blocked).toBe('calm-ticks'); // calm=1
    expect((await h.drainer.tick()).blocked).toBe('calm-ticks'); // calm=2
    const third = await h.drainer.tick(); // calm=3 → gates pass → resume
    expect(third.resumed).toBe(true);
    expect(h.respawns).toHaveLength(1);
  });

  it('oscillating load RESETS the calm streak (the stress case)', async () => {
    const h = harness();
    h.queue.considerEnqueue(candidate());
    await h.drainer.tick(); // calm=1
    await h.drainer.tick(); // calm=2
    h.setTier('moderate');
    await h.drainer.tick(); // reset to 0
    h.setTier('normal');
    expect((await h.drainer.tick()).blocked).toBe('calm-ticks'); // calm=1 again
    expect((await h.drainer.tick()).blocked).toBe('calm-ticks'); // calm=2
    expect((await h.drainer.tick()).resumed).toBe(true); // calm=3
  });

  it('quota / session-cap / migration gates each block (never bypassable)', async () => {
    for (const [dep, expected] of [
      [{ canSpawnSession: () => false }, 'quota'],
      [{ sessionCountOk: () => false }, 'session-cap'],
      [{ migrationInFlight: () => true }, 'migration-in-flight'],
    ] as const) {
      const h = harness({ deps: dep as Partial<ResumeQueueDrainerDeps> });
      h.queue.considerEnqueue(candidate());
      await warmCalm(h);
      expect((await h.drainer.tick()).blocked).toBe(expected);
      expect(h.respawns).toHaveLength(0);
      h.queue.stop();
    }
  });

  it('manual drain skips ONLY the calm-ticks gate', async () => {
    const h = harness({ deps: { canSpawnSession: () => false } });
    h.queue.considerEnqueue(candidate());
    // skipCalmTicks does NOT bypass quota.
    expect((await h.drainer.tick({ skipCalmTicks: true })).blocked).toBe('quota');
    h.queue.stop();

    const h2 = harness();
    h2.queue.considerEnqueue(candidate());
    expect((await h2.drainer.tick({ skipCalmTicks: true })).resumed).toBe(true);
  });

  it('an unreadable pressure gauge counts as NOT calm (fail-safe)', async () => {
    const h = harness({ deps: { pressureTier: () => { throw new Error('gauge'); } } });
    h.queue.considerEnqueue(candidate());
    for (let i = 0; i < 5; i++) {
      expect((await h.drainer.tick()).blocked).toBe('calm-ticks');
    }
  });
});

describe('ResumeQueueDrainer — one per tick, ordering, re-entrancy (R2.4/R2.5)', () => {
  it('resumes AT MOST ONE entry per tick, interactive first', async () => {
    const h = harness();
    h.queue.considerEnqueue(candidate({ topicId: null, jobSlug: 'job-x', jobResumeOptIn: true, tmuxSession: 'j1', workEvidence: ['open-commitment'] }));
    h.queue.considerEnqueue(candidate({ topicId: 1, tmuxSession: 't1' }));
    h.queue.considerEnqueue(candidate({ topicId: 2, tmuxSession: 't2' }));
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true); // topic 1
    expect(h.respawns).toHaveLength(1);
    expect((await h.drainer.tick()).resumed).toBe(true); // topic 2
    expect(h.respawns).toHaveLength(2);
    expect((await h.drainer.tick()).resumed).toBe(true); // then the job
    const statuses = new Map(h.queue.list().map((e) => [e.stableKey, e.status]));
    expect(statuses.get('topic:1')).toBe('respawned');
    expect(statuses.get('topic:2')).toBe('respawned');
    expect(statuses.get('job:job-x')).toBe('respawned');
  });

  it('re-entrant tick is refused', async () => {
    const h = harness({
      deps: {
        respawnTopic: async (entry) => {
          // While the first tick is mid-spawn, a second tick must bounce.
          const inner = await h.drainer.tick();
          expect(inner.blocked).toBe('re-entrant');
          return `respawned-${entry.tmuxSession}`;
        },
      },
    });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
  });

  it('paused queue never spawns', async () => {
    const h = harness();
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    h.queue.pause('emergency stop');
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.respawns).toHaveLength(0);
  });
});

describe('ResumeQueueDrainer — drain-time reality validations (R2.6, both sides)', () => {
  const cases: Array<[string, Partial<ResumeQueueDrainerDeps>, string]> = [
    ['live session exists', { liveSessionForTopic: () => true }, 'live-session-exists'],
    ['resume uuid stale', { currentResumeUuid: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, 'resume-uuid-stale'],
    ['topic owned elsewhere', { topicOwnerElsewhere: () => true }, 'topic-owner-elsewhere'],
    ['binding mismatch', { topicBindingMatches: () => false }, 'binding-mismatch'],
    ['operator stop since queuedAt', { operatorStopSince: () => true }, 'operator-stop'],
    ['cwd missing', { pathExists: () => false }, 'cwd-missing'],
  ];
  for (const [name, deps, why] of cases) {
    it(`invalidates (never spawns) on: ${name}`, async () => {
      const h = harness({ deps });
      h.queue.considerEnqueue(candidate());
      await warmCalm(h, 2);
      const r = await h.drainer.tick();
      expect(r.invalidated).toBe(1);
      expect(h.respawns).toHaveLength(0);
      const entry = h.queue.list()[0];
      expect(entry.status).toBe(`invalidated:${why}`);
    });
  }

  it('job entries: a failed jobCheck invalidates with its reason', async () => {
    const h = harness({
      deps: { jobCheck: () => ({ ok: false, why: 'job-ran-since' }) },
    });
    h.queue.considerEnqueue(candidate({ topicId: null, jobSlug: 'nightly', jobResumeOptIn: true, workEvidence: ['open-commitment'] }));
    await warmCalm(h, 2);
    const r = await h.drainer.tick();
    expect(r.invalidated).toBe(1);
    expect(h.queue.list()[0].status).toBe('invalidated:job-ran-since');
  });

  it('all validations passing → the spawn happens (the other side)', async () => {
    const h = harness();
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
  });

  it('a corrupt entry (bad resumeUuid) is invalidated by the hard invariants', async () => {
    const h = harness();
    const d = h.queue.considerEnqueue(candidate());
    // Corrupt the durable entry out-of-band (simulates on-disk corruption).
    h.queue.transition(d.entry!.id, 'queued', { resumeUuid: 'not-a-uuid-at-all' } as never);
    await warmCalm(h, 2);
    const r = await h.drainer.tick();
    expect(r.invalidated).toBe(1);
    expect(h.queue.list()[0].status).toBe('invalidated:corrupt-entry');
    expect(h.respawns).toHaveLength(0);
  });
});

describe('ResumeQueueDrainer — failure ladder + breaker (R2.9)', () => {
  it('a failed spawn retries with backoff; maxAttempts → gave-up + aggregated item', async () => {
    const h = harness({
      deps: { spawnAliveAfterGrace: async () => false },
      drainerCfg: { maxAttempts: 2, breakerThreshold: 99 },
    });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).blocked).toBe('attempt-failed'); // attempt 1
    expect(h.queue.list()[0].status).toBe('queued');
    expect(h.queue.list()[0].attempts).toBe(1);
    h.advance(2000); // past backoff
    expect((await h.drainer.tick()).blocked).toBe('attempt-failed'); // attempt 2 = max
    expect(h.queue.list()[0].status).toBe('gave-up:max-attempts');
    expect(h.aggregated.some((a) => a.kind === 'gave-up')).toBe(true);
  });

  it('breakerThreshold consecutive failures opens the breaker for the cooldown, ONE aggregated notice', async () => {
    const h = harness({
      deps: { spawnAliveAfterGrace: async () => false },
      drainerCfg: { maxAttempts: 99, breakerThreshold: 2, breakerCooldownMin: 30 },
    });
    h.queue.considerEnqueue(candidate({ topicId: 1, tmuxSession: 't1' }));
    h.queue.considerEnqueue(candidate({ topicId: 2, tmuxSession: 't2' }));
    await warmCalm(h, 2);
    await h.drainer.tick(); // failure 1
    h.advance(2000);
    await h.drainer.tick(); // failure 2 → breaker opens
    expect(h.aggregated.filter((a) => a.kind === 'breaker')).toHaveLength(1);
    expect(h.drainer.status().breakerOpen).toBe(true);
    expect((await h.drainer.tick()).blocked).toBe('breaker-open');
    // Cooldown elapses → the breaker closes and draining resumes.
    h.advance(31 * 60_000);
    h.advance(2000);
    const after = await h.drainer.tick();
    expect(after.blocked).not.toBe('breaker-open');
  });

  it('a successful resume resets the consecutive-failure streak', async () => {
    let fail = true;
    const h = harness({
      deps: { spawnAliveAfterGrace: async () => !fail },
      drainerCfg: { maxAttempts: 99, breakerThreshold: 3 },
    });
    h.queue.considerEnqueue(candidate({ topicId: 1, tmuxSession: 't1' }));
    h.queue.considerEnqueue(candidate({ topicId: 2, tmuxSession: 't2' }));
    await warmCalm(h, 2);
    await h.drainer.tick(); // t1 fails (streak 1)
    fail = false;
    h.advance(2000);
    await h.drainer.tick(); // t2 succeeds → streak resets
    expect(h.drainer.status().consecutiveFailures).toBe(0);
  });
});

describe('ResumeQueueDrainer — dry-run inertness + Tier1 paths (R2.4 / P7)', () => {
  it('dry-run: audits would-resume ONCE per entry, never spawns, never notices', async () => {
    const h = harness({ queueCfg: { dryRun: true } });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).blocked).toBe('dry-run');
    expect((await h.drainer.tick()).blocked).toBe('dry-run');
    expect(h.respawns).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
    expect(h.audits.filter((a) => a.event === 'would-resume')).toHaveLength(1);
  });

  it('Tier1 observe-only: a NEGATIVE verdict is audited and the resume still happens', async () => {
    const h = harness({
      deps: { tier1Check: async () => ({ sensible: false, reasoning: 'reason contradicts evidence' }) },
    });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true); // never defers
    const verdicts = h.audits.filter((a) => a.event === 'tier1-verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].sensible).toBe(false);
  });

  it('Tier1 deadline: a hung check sheds and the gates proceed', async () => {
    const h = harness({
      deps: { tier1Check: () => new Promise(() => { /* never resolves */ }) },
      drainerCfg: { tier1DeadlineMs: 10 },
    });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    const verdicts = h.audits.filter((a) => a.event === 'tier1-verdict');
    expect(verdicts[0].supervision).toBe('shed');
  });

  it('tier1Check:false lever switches the check off entirely', async () => {
    const probe = vi.fn(async () => ({ sensible: true }));
    const h = harness({
      deps: { tier1Check: probe },
      drainerCfg: { tier1Check: false },
    });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('R2.11: the resume notice fires on success; the continuation prompt treats reason as data', async () => {
    const h = harness();
    const d = h.queue.considerEnqueue(candidate({ reason: 'quota-shed `evil` injection' }));
    await warmCalm(h, 2);
    await h.drainer.tick();
    expect(h.notices).toEqual([d.entry!.id]);
    const prompt = h.drainer.continuationPrompt(h.queue.get(d.entry!.id)!);
    expect(prompt).toContain('restarted to pick the work back up');
    expect(prompt).not.toContain('`evil`'); // backticks neutralized (literal data)
    expect(prompt).toContain('build-or-autonomous-active');
  });

  it('ACT-839 R2.1: uncommitted-worktree-work prepends the verbatim commit-first directive as the first line', () => {
    const h = harness();
    const d = h.queue.considerEnqueue(candidate({ workEvidence: ['uncommitted-worktree-work'] }));
    const prompt = h.drainer.continuationPrompt(h.queue.get(d.entry!.id)!);
    expect(prompt.startsWith('You were revived because your worktree had uncommitted changes')).toBe(true);
    expect(prompt).toContain('commit them with a real, descriptive commit, or deliberately preserve/discard');
    expect(prompt).toContain('restarted to pick the work back up'); // base text still present
  });

  it('ACT-839 R2.1: with BOTH uncommitted-worktree-work + build-or-autonomous-active, the build second-sentence is included', () => {
    const h = harness();
    const d = h.queue.considerEnqueue(candidate({ workEvidence: ['uncommitted-worktree-work', 'build-or-autonomous-active'] }));
    const prompt = h.drainer.continuationPrompt(h.queue.get(d.entry!.id)!);
    expect(prompt).toContain('A build/autonomous run was also active');
  });

  it('ACT-839 R2.1: NO directive when uncommitted-worktree-work is absent (unchanged prompt)', () => {
    const h = harness();
    const d = h.queue.considerEnqueue(candidate({ workEvidence: ['open-commitment'] }));
    const prompt = h.drainer.continuationPrompt(h.queue.get(d.entry!.id)!);
    expect(prompt.startsWith('You were revived because your worktree')).toBe(false);
    expect(prompt.startsWith('Your previous session was shut down')).toBe(true);
  });
});

describe('ResumeQueueDrainer — ACT-839 R2.2 worktree-revival obligation hook', () => {
  it('fires onWorktreeRevival after a successful resume of an uncommitted-worktree entry', async () => {
    const fired: string[] = [];
    const h = harness({ deps: { onWorktreeRevival: (e) => fired.push(e.id) } });
    const d = h.queue.considerEnqueue(candidate({ workEvidence: ['uncommitted-worktree-work'] }));
    await warmCalm(h, 2);
    await h.drainer.tick();
    expect(fired).toEqual([d.entry!.id]);
  });
  it('does NOT fire for an entry without uncommitted-worktree-work', async () => {
    const fired: string[] = [];
    const h = harness({ deps: { onWorktreeRevival: (e) => fired.push(e.id) } });
    h.queue.considerEnqueue(candidate({ workEvidence: ['open-commitment'] }));
    await warmCalm(h, 2);
    await h.drainer.tick();
    expect(fired).toEqual([]);
  });
  it('a throw in onWorktreeRevival never fails the resume', async () => {
    const h = harness({ deps: { onWorktreeRevival: () => { throw new Error('commitment boom'); } } });
    const d = h.queue.considerEnqueue(candidate({ workEvidence: ['uncommitted-worktree-work'] }));
    await warmCalm(h, 2);
    const r = await h.drainer.tick();
    expect(r.resumed).toBe(true);
    expect(h.queue.get(d.entry!.id)?.status).toBe('respawned');
  });
});

describe('isAutoResumableEmergencyPauseReason — closed-world predicate (codex r2 #2)', () => {
  it('matches the MessageSentinel emergency-stop reason → true', () => {
    expect(isAutoResumableEmergencyPauseReason('message-sentinel emergency stop')).toBe(true);
  });
  it('does NOT match the deliberate autonomous stop-all reason → false', () => {
    expect(isAutoResumableEmergencyPauseReason('autonomous stop-all')).toBe(false);
  });
  it('does NOT match an unrelated maintenance-style reason → false', () => {
    expect(isAutoResumableEmergencyPauseReason('scheduled maintenance pause')).toBe(false);
  });
  it('a missing/undefined reason → false (safe side)', () => {
    expect(isAutoResumableEmergencyPauseReason(undefined)).toBe(false);
    expect(isAutoResumableEmergencyPauseReason(null)).toBe(false);
  });

  // Mechanical closed-world enforcement (codex r6 #2): a comment is not enough.
  // Discover every STRING-LITERAL passed to `ResumeQueue.pause(...)` across src/
  // and assert each is pinned to a KNOWN auto-resume verdict here. A new pause
  // callsite with an un-pinned reason fails this test — so a future reason can
  // never silently change Layer-2 auto-resume behavior.
  it('every ResumeQueue.pause(...) string-literal callsite in src/ is pinned to a known verdict', () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    const KNOWN: Record<string, boolean> = {
      'message-sentinel emergency stop': true, // routes.ts MessageSentinel emergency-stop → auto-resumable
      'autonomous stop-all': false,            // routes.ts deliberate operator halt → NOT auto-resumable
    };
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) { walk(full); continue; }
        if (!full.endsWith('.ts')) continue;
        const text = fs.readFileSync(full, 'utf-8');
        // Match `.pause('…')` / `.pause("…")` string-literal callsites (the
        // resume-queue pause lever; dynamic-reason callsites, if any, are
        // out of scope for the literal scan and would be caught at review).
        const re = /\.pause\(\s*(['"])([^'"]+)\1/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) found.add(m[2]);
      }
    };
    walk(srcRoot);
    // Every discovered literal reason must be a known, pinned verdict.
    for (const reason of found) {
      expect(
        Object.prototype.hasOwnProperty.call(KNOWN, reason),
        `Unpinned ResumeQueue.pause() reason "${reason}" — add it to KNOWN with its ` +
        `auto-resume verdict (and consider isAutoResumableEmergencyPauseReason()).`,
      ).toBe(true);
      expect(isAutoResumableEmergencyPauseReason(reason)).toBe(KNOWN[reason]);
    }
    // Sanity: the scan actually found the two known resume-queue pause reasons.
    expect(found.has('message-sentinel emergency stop')).toBe(true);
    expect(found.has('autonomous stop-all')).toBe(true);
  });
});

describe('ResumeQueueDrainer — stale emergency-pause robustness (Layer 1 + Layer 2)', () => {
  const EMERGENCY = 'message-sentinel emergency stop';
  const STOP_ALL = 'autonomous stop-all';

  /** Enqueue an active-autonomous-run entry (the only reason that triggers Layer 2). */
  function activeRunCandidate(over: Partial<ResumeCandidateInput> = {}): ResumeCandidateInput {
    return candidate({ reason: AGE_LIMIT_ACTIVE_RUN_REASON, ...over });
  }

  it('Layer 1: paused + waiting + live → raises paused-waiting ONCE per pause episode; never spawns; still blocked:paused when not stale', async () => {
    const h = harness();
    h.queue.considerEnqueue(candidate()); // plain mid-work entry (not active-run)
    await warmCalm(h, 2);
    h.queue.pause(EMERGENCY);
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect((await h.drainer.tick()).blocked).toBe('paused');
    // Fired exactly once across the steady episode.
    expect(h.aggregated.filter((a) => a.kind === 'paused-waiting')).toHaveLength(1);
    expect(h.respawns).toHaveLength(0);
  });

  it('Layer 1: a NEW pause episode (unpause + re-pause) re-raises paused-waiting', async () => {
    const h = harness();
    h.queue.considerEnqueue(candidate());
    h.queue.pause(EMERGENCY);
    await h.drainer.tick();
    h.queue.unpause();
    h.advance(1000);
    h.queue.pause(EMERGENCY); // new pausedAt
    await h.drainer.tick();
    expect(h.aggregated.filter((a) => a.kind === 'paused-waiting')).toHaveLength(2);
  });

  it('Layer 1: a GROWING backlog under the SAME pause re-raises; a steady count does not (codex r3 #3)', async () => {
    const h = harness();
    h.queue.considerEnqueue(candidate({ topicId: 1, tmuxSession: 't1' }));
    h.queue.pause(EMERGENCY);
    await h.drainer.tick(); // count=1 → alert
    await h.drainer.tick(); // count=1 → no re-alert
    h.queue.considerEnqueue(candidate({ topicId: 2, tmuxSession: 't2' })); // count grows to 2
    await h.drainer.tick(); // count=2 → re-alert
    await h.drainer.tick(); // count=2 → no re-alert
    expect(h.aggregated.filter((a) => a.kind === 'paused-waiting')).toHaveLength(2);
  });

  it('Layer 1+2: paused + waiting + DRY-RUN → no alert, no auto-resume (observe-only silence)', async () => {
    const h = harness({ queueCfg: { dryRun: true } });
    h.queue.considerEnqueue(activeRunCandidate());
    h.queue.pause(EMERGENCY);
    h.advance(61 * 60_000); // well past the 60-min default — would be stale if live
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.aggregated.filter((a) => a.kind === 'paused-waiting')).toHaveLength(0);
    expect(h.aggregated.filter((a) => a.kind === 'auto-resumed-stale-pause')).toHaveLength(0);
    expect(h.queue.isPaused()).toBe(true);
  });

  it('Layer 2: stale emergency pause (active-run entry queued > threshold after pausedAt) → unpause, audit, notice, then drains', async () => {
    const h = harness();
    await warmCalm(h, 3); // satisfy calm gate so the fall-through actually drains
    h.queue.pause(EMERGENCY); // pausedAt = T0
    h.advance(61 * 60_000); // past 60-min default
    h.queue.considerEnqueue(activeRunCandidate()); // queuedAt = T0 + 61m
    const r = await h.drainer.tick();
    expect(r.resumed).toBe(true); // fell through to normal draining and spawned
    expect(h.queue.isPaused()).toBe(false);
    expect(h.audits.some((a) => a.event === 'auto-resumed-stale-pause')).toBe(true);
    expect(h.aggregated.some((a) => a.kind === 'auto-resumed-stale-pause')).toBe(true);
    expect(h.respawns).toHaveLength(1);
  });

  it('Layer 2 boundary: exactly AT threshold → NOT stale (strict >), stays paused', async () => {
    const h = harness({ drainerCfg: { staleEmergencyPauseAutoResumeMin: 60 } });
    h.queue.pause(EMERGENCY);
    h.advance(60 * 60_000); // exactly 60 min → NOT strictly greater
    h.queue.considerEnqueue(activeRunCandidate());
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.queue.isPaused()).toBe(true);
  });

  it('Layer 2 boundary: just over threshold (+1ms) → stale, auto-resumes', async () => {
    const h = harness({ drainerCfg: { staleEmergencyPauseAutoResumeMin: 60 } });
    await warmCalm(h, 3);
    h.queue.pause(EMERGENCY);
    h.advance(60 * 60_000 + 1); // strictly greater
    h.queue.considerEnqueue(activeRunCandidate());
    await h.drainer.tick();
    expect(h.queue.isPaused()).toBe(false);
  });

  it('Layer 2: malformed pausedAt → NOT stale (safe side, no unpause)', async () => {
    const h = harness();
    h.queue.considerEnqueue(activeRunCandidate());
    h.queue.pause(EMERGENCY);
    // Corrupt the persisted pausedAt out-of-band (simulates on-disk corruption).
    (h.queue as unknown as { state: { pausedAt: string } }).state.pausedAt = 'not-a-date';
    h.advance(120 * 60_000);
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.queue.isPaused()).toBe(true);
  });

  it('Layer 2: FRESH emergency pause (active-run queued < threshold after pausedAt) → does NOT auto-resume', async () => {
    const h = harness();
    h.queue.pause(EMERGENCY);
    h.advance(5 * 60_000); // only 5 min — fresh
    h.queue.considerEnqueue(activeRunCandidate());
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.queue.isPaused()).toBe(true);
    expect(h.aggregated.some((a) => a.kind === 'auto-resumed-stale-pause')).toBe(false);
    // Layer 1 still fires for the waiting entry.
    expect(h.aggregated.filter((a) => a.kind === 'paused-waiting')).toHaveLength(1);
  });

  it('Layer 2: deliberate autonomous stop-all pause + active-run entry → does NOT auto-resume', async () => {
    const h = harness();
    h.queue.pause(STOP_ALL); // reason does NOT match /emergency|sentinel/i
    h.advance(120 * 60_000);
    h.queue.considerEnqueue(activeRunCandidate());
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.queue.isPaused()).toBe(true);
  });

  it('overlap: stop-all THEN emergency-stop → deliberate halt NOT downgraded; NOT auto-resumed (codex r4 #3 / gemini r4 #2)', async () => {
    const h = harness();
    h.queue.pause(STOP_ALL); // the deliberate halt pauses FIRST
    h.queue.pause(EMERGENCY); // no-op: an emergency stop never downgrades a deliberate halt
    expect(h.queue.pauseInfo().reason).toBe(STOP_ALL); // the deliberate halt is preserved
    h.advance(120 * 60_000);
    h.queue.considerEnqueue(activeRunCandidate());
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.queue.isPaused()).toBe(true);
  });

  it('overlap: emergency-stop THEN stop-all → pause UPGRADED to the deliberate halt; NOT auto-resumed (codex r5 #1 / gemini r5 #2)', async () => {
    const h = harness();
    const pausedAtBefore = (() => { h.queue.pause(EMERGENCY); return h.queue.pauseInfo().pausedAt; })();
    h.queue.pause(STOP_ALL); // a later deliberate halt UPGRADES the auto-resumable pause
    expect(h.queue.pauseInfo().reason).toBe(STOP_ALL);
    expect(h.queue.pauseInfo().pausedAt).toBe(pausedAtBefore); // freeze clock continuous (pausedAt unchanged)
    expect(h.audits.some((a) => a.event === 'pause-upgraded' && a.to === STOP_ALL)).toBe(true);
    h.advance(120 * 60_000);
    h.queue.considerEnqueue(activeRunCandidate());
    expect((await h.drainer.tick()).blocked).toBe('paused'); // the upgraded halt is not auto-resumed
    expect(h.queue.isPaused()).toBe(true);
  });

  it('Layer 2: a plain mid-work entry (not active-run) under a stale emergency pause → does NOT auto-resume', async () => {
    const h = harness();
    h.queue.pause(EMERGENCY);
    h.advance(120 * 60_000);
    h.queue.considerEnqueue(candidate()); // reason 'quota-shed', not AGE_LIMIT_ACTIVE_RUN_REASON
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.queue.isPaused()).toBe(true);
  });

  it('Layer 2: autoResumeStalePause:false → Layer 2 off, Layer 1 still fires', async () => {
    const h = harness({ drainerCfg: { autoResumeStalePause: false } });
    h.queue.pause(EMERGENCY);
    h.advance(120 * 60_000);
    h.queue.considerEnqueue(activeRunCandidate());
    expect((await h.drainer.tick()).blocked).toBe('paused');
    expect(h.queue.isPaused()).toBe(true);
    expect(h.aggregated.filter((a) => a.kind === 'paused-waiting')).toHaveLength(1);
  });

  it('Layer 2: after auto-resume, a candidate whose topic has an operatorStopSince record is still invalidated:operator-stop (per-topic guardrail intact — gemini r2 #1)', async () => {
    const h = harness({ deps: { operatorStopSince: () => true } });
    await warmCalm(h, 3);
    h.queue.pause(EMERGENCY);
    h.advance(61 * 60_000);
    h.queue.considerEnqueue(activeRunCandidate());
    const r = await h.drainer.tick();
    // The queue auto-resumed, but the per-topic stop guard still blocks the spawn.
    expect(h.queue.isPaused()).toBe(false);
    expect(r.invalidated).toBe(1);
    expect(h.respawns).toHaveLength(0);
    expect(h.queue.list()[0].status).toBe('invalidated:operator-stop');
  });
});

describe('ResumeQueueDrainer — GAP-B D9 commitment drain-time re-check (both sides)', () => {
  const committedCandidate = (over?: Partial<import('../../src/monitoring/ResumeQueue.js').ResumeQueueEntry>) =>
    candidate({ reason: COMMITMENT_ACTIVE_RUN_REASON, workEvidence: ['build-or-autonomous-active'], ...over });

  it('commitment still active at drain ⇒ spawn proceeds', async () => {
    const h = harness({ deps: { commitmentStillActiveForTopic: () => true } });
    h.queue.considerEnqueue(committedCandidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    expect(h.respawns).toHaveLength(1);
  });

  it('commitment closed/lapsed between enqueue and drain ⇒ invalidated (never spawns)', async () => {
    const h = harness({ deps: { commitmentStillActiveForTopic: () => false } });
    h.queue.considerEnqueue(committedCandidate());
    await warmCalm(h, 2);
    const r = await h.drainer.tick();
    expect(r.invalidated).toBe(1);
    expect(h.respawns).toHaveLength(0);
    expect(h.queue.list()[0].status).toBe('invalidated:commitment-no-longer-active');
  });

  it('the re-check is gated on the COMMITMENT reason only (a quota-shed entry never consults it)', async () => {
    let consulted = false;
    const h = harness({
      deps: { commitmentStillActiveForTopic: () => { consulted = true; return false; } },
    });
    // reason 'quota-shed' (the candidate default), NOT the commitment reason.
    h.queue.considerEnqueue(candidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    expect(consulted).toBe(false);
  });

  it('a throwing dep resolves SAFE (still-active ⇒ spawn proceeds, never wrongly dropped)', async () => {
    const h = harness({
      deps: { commitmentStillActiveForTopic: () => { throw new Error('boom'); } },
    });
    h.queue.considerEnqueue(committedCandidate());
    await warmCalm(h, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
  });
});
