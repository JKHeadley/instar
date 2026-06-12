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
});
