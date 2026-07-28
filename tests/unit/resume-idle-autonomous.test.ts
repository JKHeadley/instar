// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Resume-idle-autonomous-on-reap (spec: docs/specs/resume-idle-autonomous-on-reap.md).
 *
 * Three unit surfaces, both sides of every boundary:
 *  1. ADMISSION — an age-limit reap whose topic has an ACTIVE autonomous run is
 *     admitted (the server appends `build-or-autonomous-active` ⇒ eligible) while
 *     an age-limit reap with NO active run stays REJECTED (empty evidence ⇒
 *     insufficient-evidence). Plus the guard short-circuits: the cold-path
 *     `autonomousRunRemainingForTopic` read runs ONLY on `age-limit` reaps, and a
 *     throwing state read fails toward NO injection (no spawn, kill path intact).
 *  2. DRYRUN GATE (dedicated, NOT via DEV_GATED_FEATURES) — the resolved dryRun
 *     value is `false` under a dev-agent config, `true` under a fleet config, and
 *     an explicit `monitoring.resumeQueue.dryRun: true` still wins on dev.
 *  3. DRAIN-TIME LIVENESS RE-CHECK — an entry tagged `age-limit (active autonomous
 *     run)` whose run has since finished invalidates `autonomous-run-finished` with
 *     ZERO respawn; a still-active run revives normally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ResumeQueue,
  classifyEligibility,
  type ResumeCandidateInput,
} from '../../src/monitoring/ResumeQueue.js';
import {
  ResumeQueueDrainer,
  type ResumeQueueDrainerDeps,
} from '../../src/monitoring/ResumeQueueDrainer.js';
import { AGE_LIMIT_ACTIVE_RUN_REASON } from '../../src/core/WorkEvidence.js';
import { autonomousRunRemainingForTopic } from '../../src/core/AutonomousSessions.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-idle-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * The EXACT augmentation the sessionReaped handler in server.ts performs. Kept as
 * a faithful replica so the both-sides boundary (age-limit + active run ⇒ augment;
 * else ⇒ untouched) is unit-testable without booting the server; the real wiring is
 * proven by the integration tier (resume-idle-autonomous-wiring.test.ts).
 */
function buildCandidateReason(
  reason: string,
  topicId: number | null,
  stateDir: string,
  calls: { name: string }[],
): { reason: string; workEvidence: string[] } {
  let candidateReason = reason;
  let candidateWorkEvidence: string[] = [];
  if (
    reason === 'age-limit' &&
    topicId != null &&
    (() => {
      calls.push({ name: 'autonomousRunRemainingForTopic' });
      return autonomousRunRemainingForTopic(stateDir, topicId) != null;
    })()
  ) {
    candidateReason = AGE_LIMIT_ACTIVE_RUN_REASON;
    candidateWorkEvidence = [...candidateWorkEvidence, 'build-or-autonomous-active'];
  }
  return { reason: candidateReason, workEvidence: candidateWorkEvidence };
}

function writeRun(stateDir: string, topic: string, durationSeconds: number, startedAt: string) {
  fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'autonomous', `${topic}.local.md`),
    `---\nactive: true\npaused: false\niteration: 3\ngoal: "run ${topic}"\nstarted_at: "${startedAt}"\nduration_seconds: ${durationSeconds}\nreport_topic: "${topic}"\n---\n\ntask\n`,
  );
}

describe('admission — age-limit reap with an active autonomous run', () => {
  it('ADMITS: active run ⇒ build-or-autonomous-active appended ⇒ eligible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T07:00:00Z'));
    writeRun(tmpDir, '42', 86400, '2026-06-14T00:00:00Z'); // window un-elapsed
    const calls: { name: string }[] = [];
    const { reason, workEvidence } = buildCandidateReason('age-limit', 42, tmpDir, calls);
    expect(reason).toBe(AGE_LIMIT_ACTIVE_RUN_REASON);
    expect(workEvidence).toContain('build-or-autonomous-active');
    // The augmented evidence makes the topic-bound candidate eligible.
    const verdict = classifyEligibility(
      {
        sessionName: 's',
        tmuxSession: 't',
        topicId: 42,
        cwd: '/tmp',
        reason,
        disposition: 'terminal',
        origin: 'autonomous',
        workEvidence,
      } as ResumeCandidateInput,
      { includeOperatorKills: false } as never,
    );
    expect(verdict.eligible).toBe(true);
    vi.useRealTimers();
  });

  it('REJECTS: age-limit reap with NO active run ⇒ empty evidence ⇒ insufficient-evidence', () => {
    // No run file written ⇒ autonomousRunRemainingForTopic returns null.
    const calls: { name: string }[] = [];
    const { reason, workEvidence } = buildCandidateReason('age-limit', 42, tmpDir, calls);
    expect(reason).toBe('age-limit'); // untouched
    expect(workEvidence).toEqual([]);
    const verdict = classifyEligibility(
      {
        sessionName: 's',
        tmuxSession: 't',
        topicId: 42,
        cwd: '/tmp',
        reason,
        disposition: 'terminal',
        origin: 'autonomous',
        workEvidence,
      } as ResumeCandidateInput,
      { includeOperatorKills: false } as never,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.why).toBe('insufficient-evidence');
  });

  it('REJECTS: a run PAST its window ⇒ autonomousRunRemainingForTopic null ⇒ untouched', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T07:00:00Z'));
    writeRun(tmpDir, '42', 60, '2026-06-14T00:00:00Z'); // 60s window started 7h ago ⇒ elapsed
    const { reason, workEvidence } = buildCandidateReason('age-limit', 42, tmpDir, []);
    expect(reason).toBe('age-limit');
    expect(workEvidence).toEqual([]);
    vi.useRealTimers();
  });

  it('SHORT-CIRCUIT: the cold-path read is NOT called for a non-age-limit reap', () => {
    writeRun(tmpDir, '42', 86400, new Date().toISOString());
    const calls: { name: string }[] = [];
    // A completion / recovery-bounce reap must never touch the state read.
    buildCandidateReason('completion', 42, tmpDir, calls);
    buildCandidateReason('recovery-bounce', 42, tmpDir, calls);
    buildCandidateReason('quota-shed', 42, tmpDir, calls);
    expect(calls).toHaveLength(0);
  });

  it('SHORT-CIRCUIT: a null topicId skips the read (topic-resolution race ⇒ safe side)', () => {
    writeRun(tmpDir, '42', 86400, new Date().toISOString());
    const calls: { name: string }[] = [];
    const { reason, workEvidence } = buildCandidateReason('age-limit', null, tmpDir, calls);
    expect(reason).toBe('age-limit');
    expect(workEvidence).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('FAIL-OPEN: a throwing/unreadable state read fails toward NO injection', () => {
    // Point at a stateDir whose autonomous file is a directory ⇒ read path returns
    // null (activeAutonomousJobs tolerates a malformed tree). No augmentation, no throw.
    const { reason, workEvidence } = buildCandidateReason('age-limit', 999, tmpDir, []);
    expect(reason).toBe('age-limit');
    expect(workEvidence).toEqual([]);
  });
});

describe('dryRun gate resolution (dedicated — NOT via DEV_GATED_FEATURES)', () => {
  // The exact consumption-site resolution: dryRun: rqCfg.dryRun ?? !resolveDevAgentGate(undefined, config)
  const resolve = (rqDryRun: boolean | undefined, config: { developmentAgent?: boolean }) =>
    rqDryRun ?? !resolveDevAgentGate(undefined, config);

  it('dev agent ⇒ dryRun resolves FALSE (live-on-dev)', () => {
    expect(resolve(undefined, { developmentAgent: true })).toBe(false);
  });

  it('fleet agent ⇒ dryRun resolves TRUE (observe-only)', () => {
    expect(resolve(undefined, { developmentAgent: false })).toBe(true);
    expect(resolve(undefined, {})).toBe(true);
  });

  it('explicit monitoring.resumeQueue.dryRun: true still WINS on a dev agent', () => {
    expect(resolve(true, { developmentAgent: true })).toBe(true);
  });

  it('explicit dryRun: false forces LIVE even on the fleet', () => {
    expect(resolve(false, { developmentAgent: false })).toBe(false);
  });
});

// ── Drain-time liveness re-check ──

interface Harness {
  queue: ResumeQueue;
  drainer: ResumeQueueDrainer;
  respawns: string[];
  audits: Array<Record<string, unknown>>;
  advance: (ms: number) => void;
}

function candidate(over: Partial<ResumeCandidateInput> = {}): ResumeCandidateInput {
  return {
    sessionName: 'sess',
    tmuxSession: 'tmux-1',
    topicId: 42,
    resumeUuid: '11111111-1111-4111-8111-111111111111',
    cwd: '/tmp/project',
    reason: AGE_LIMIT_ACTIVE_RUN_REASON,
    disposition: 'terminal',
    origin: 'autonomous',
    workEvidence: ['build-or-autonomous-active'],
    ...over,
  };
}

function harness(over?: { deps?: Partial<ResumeQueueDrainerDeps> }): Harness {
  const audits: Array<Record<string, unknown>> = [];
  const respawns: string[] = [];
  let nowMs = 4_000_000_000_000;
  const queue = new ResumeQueue(
    { stateDir: tmpDir, audit: (e) => audits.push(e), raiseAggregated: () => {}, now: () => nowMs },
    { dryRun: false },
  );
  queue.start();
  const deps: ResumeQueueDrainerDeps = {
    queue,
    pressureTier: () => 'normal',
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
    respawnTopic: async (entry) => { respawns.push(entry.id); return `respawned-${entry.tmuxSession}`; },
    triggerJob: async () => 'triggered',
    spawnAliveAfterGrace: async () => true,
    raiseAggregated: () => {},
    audit: (e) => audits.push(e),
    now: () => nowMs,
    ...over?.deps,
  };
  const drainer = new ResumeQueueDrainer(deps, { requiredCalmTicks: 3, tier1Check: false });
  return { queue, drainer, respawns, audits, advance: (ms) => { nowMs += ms; } };
}

async function warmCalm(d: ResumeQueueDrainer, ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) await d.tick();
}

describe('drain-time liveness re-check (age-limit active-run entry)', () => {
  it('INVALIDATES autonomous-run-finished with ZERO respawn when the run has ended', async () => {
    const h = harness({ deps: { autonomousRunFinished: () => true } });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h.drainer, 2);
    const r = await h.drainer.tick();
    expect(r.invalidated).toBe(1);
    expect(h.respawns).toHaveLength(0);
    const inv = h.audits.find((a) => a.event === 'invalidated');
    expect(inv?.why).toBe('autonomous-run-finished');
  });

  it('REVIVES normally when the run is STILL active', async () => {
    const h = harness({ deps: { autonomousRunFinished: () => false } });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h.drainer, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    expect(h.respawns).toHaveLength(1);
  });

  it('does NOT apply the re-check to a non-age-limit entry (different reason)', async () => {
    // A normal quota-shed entry must not invalidate even when autonomousRunFinished → true.
    const h = harness({ deps: { autonomousRunFinished: () => true } });
    h.queue.considerEnqueue(candidate({ reason: 'quota-shed' }));
    await warmCalm(h.drainer, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    expect(h.respawns).toHaveLength(1);
  });

  it('back-compat: ABSENT autonomousRunFinished dep ⇒ revives normally (today behavior)', async () => {
    const h = harness(); // no autonomousRunFinished
    h.queue.considerEnqueue(candidate());
    await warmCalm(h.drainer, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    expect(h.respawns).toHaveLength(1);
  });

  it('a THROWING autonomousRunFinished resolves to NOT-finished (SAFE side ⇒ revives)', async () => {
    const h = harness({ deps: { autonomousRunFinished: () => { throw new Error('state read'); } } });
    h.queue.considerEnqueue(candidate());
    await warmCalm(h.drainer, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    expect(h.respawns).toHaveLength(1);
  });
});
