// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Resume-idle-autonomous-on-reap — integration / wiring integrity
 * (spec: docs/specs/resume-idle-autonomous-on-reap.md).
 *
 * Composes the REAL ResumeQueue + REAL ResumeQueueDrainer + the REAL
 * `autonomousRunRemainingForTopic` helper over a temp stateDir, proving:
 *  - WIRING INTEGRITY: the `autonomousRunFinished` dep is non-null and DELEGATES
 *    to the real run-window read (not a mock-against-mock); a finished run ⇒
 *    invalidate `autonomous-run-finished`; a live run ⇒ revive.
 *  - DOUBLE-SPAWN LENS (#1 blocker): an age-limit active-run entry that has since
 *    revived via a message — (a) a live session for the topic ⇒
 *    `live-session-exists`; (b) the topic's resume UUID moved on ⇒
 *    `resume-uuid-stale` — BOTH ZERO respawn.
 *  - REVIVAL-LOOP LENS: an age-limit active-run entry re-reaped after each revive
 *    hits the EXISTING resurrection cap and gives up LOUDLY (exactly one
 *    aggregated `resurrection-cap` notice), never a silent loop.
 *  - LEASE LENS: topicOwnerElsewhere ⇒ `topic-owner-elsewhere`, ZERO respawn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ResumeQueue, type ResumeCandidateInput } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer, type ResumeQueueDrainerDeps } from '../../src/monitoring/ResumeQueueDrainer.js';
import { autonomousRunRemainingForTopic } from '../../src/core/AutonomousSessions.js';
import { AGE_LIMIT_ACTIVE_RUN_REASON } from '../../src/core/WorkEvidence.js';

let tmpDir: string; // serves as the .instar stateDir
const UUID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-idle-wiring-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRun(topic: string | number, durationSeconds: number, startedAt: string) {
  fs.mkdirSync(path.join(tmpDir, 'autonomous'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'autonomous', `${topic}.local.md`),
    `---\nactive: true\npaused: false\niteration: 4\ngoal: "run ${topic}"\nstarted_at: "${startedAt}"\nduration_seconds: ${durationSeconds}\nreport_topic: "${topic}"\n---\n\ntask\n`,
  );
}
function endRun(topic: string | number) {
  fs.rmSync(path.join(tmpDir, 'autonomous', `${topic}.local.md`), { force: true });
}

function candidate(over: Partial<ResumeCandidateInput> = {}): ResumeCandidateInput {
  return {
    sessionName: 'sess',
    tmuxSession: 'tmux-1',
    topicId: 42,
    resumeUuid: UUID,
    cwd: path.join(tmpDir, 'project'),
    reason: AGE_LIMIT_ACTIVE_RUN_REASON,
    disposition: 'terminal',
    origin: 'autonomous',
    workEvidence: ['build-or-autonomous-active'],
    ...over,
  };
}

interface Harness {
  queue: ResumeQueue;
  drainer: ResumeQueueDrainer;
  respawns: string[];
  audits: Array<Record<string, unknown>>;
  aggregated: Array<{ kind: string; detail: string }>;
  deps: ResumeQueueDrainerDeps;
}

/** Wire the drainer EXACTLY as server.ts wires it: autonomousRunFinished delegates
 *  to the real helper over the real stateDir. */
function harness(over?: { deps?: Partial<ResumeQueueDrainerDeps> }): Harness {
  fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
  const audits: Array<Record<string, unknown>> = [];
  const aggregated: Array<{ kind: string; detail: string }> = [];
  const respawns: string[] = [];
  let nowMs = Date.now();
  const queue = new ResumeQueue(
    { stateDir: tmpDir, audit: (e) => audits.push(e), raiseAggregated: (k, d) => aggregated.push({ kind: k, detail: d }), now: () => nowMs },
    { dryRun: false, maxResurrections: 2 },
  );
  queue.start();
  let currentUuid: string | null = UUID;
  let liveTopics = new Set<number>();
  let ownerElsewhere = false;
  const deps: ResumeQueueDrainerDeps = {
    queue,
    pressureTier: () => 'normal',
    canSpawnSession: () => true,
    sessionCountOk: () => true,
    migrationInFlight: () => false,
    liveSessionForTopic: (t) => liveTopics.has(t),
    currentResumeUuid: () => currentUuid,
    topicOwnerElsewhere: () => ownerElsewhere,
    topicBindingMatches: () => true,
    operatorStopSince: () => false,
    // THE WIRING UNDER TEST: real helper, real stateDir (server.ts shape).
    autonomousRunFinished: (topicId) => autonomousRunRemainingForTopic(tmpDir, topicId) == null,
    jobCheck: () => ({ ok: true }),
    pathExists: (p) => fs.existsSync(p),
    respawnTopic: async (entry) => { respawns.push(entry.id); return `respawned-${entry.tmuxSession}`; },
    triggerJob: async () => 'triggered',
    spawnAliveAfterGrace: async () => true,
    raiseAggregated: (k, d) => aggregated.push({ kind: k, detail: d }),
    audit: (e) => audits.push(e),
    now: () => nowMs,
    ...over?.deps,
  };
  // expose the mutable controls through closures the tests set via deps overrides
  (deps as Record<string, unknown>).__setUuid = (u: string | null) => { currentUuid = u; };
  (deps as Record<string, unknown>).__setLive = (t: number, v: boolean) => { v ? liveTopics.add(t) : liveTopics.delete(t); };
  (deps as Record<string, unknown>).__setOwnerElsewhere = (v: boolean) => { ownerElsewhere = v; };
  const drainer = new ResumeQueueDrainer(deps, { requiredCalmTicks: 3, tier1Check: false });
  return { queue, drainer, respawns, audits, aggregated, deps };
}

async function warmCalm(d: ResumeQueueDrainer, ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) await d.tick();
}

describe('wiring integrity — autonomousRunFinished delegates to the real helper', () => {
  it('a FINISHED run (state file gone) ⇒ invalidate autonomous-run-finished, ZERO respawn', async () => {
    const h = harness();
    // No run file ⇒ the real helper returns null ⇒ finished.
    h.queue.considerEnqueue(candidate());
    await warmCalm(h.drainer, 2);
    const r = await h.drainer.tick();
    expect(r.invalidated).toBe(1);
    expect(h.respawns).toHaveLength(0);
    expect(h.audits.find((a) => a.event === 'invalidated')?.why).toBe('autonomous-run-finished');
  });

  it('a LIVE run (un-elapsed window) ⇒ revives via the real helper', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T07:00:00Z'));
    writeRun(42, 86400, '2026-06-14T00:00:00Z'); // ~17h left
    const h = harness();
    h.queue.considerEnqueue(candidate());
    await warmCalm(h.drainer, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);
    expect(h.respawns).toHaveLength(1);
  });

  it('a run PAST its window ⇒ the real helper returns null ⇒ invalidate (no respawn)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T07:00:00Z'));
    writeRun(42, 60, '2026-06-14T00:00:00Z'); // elapsed
    const h = harness();
    h.queue.considerEnqueue(candidate());
    await warmCalm(h.drainer, 2);
    expect((await h.drainer.tick()).invalidated).toBe(1);
    expect(h.respawns).toHaveLength(0);
  });
});

describe('double-spawn lens (#1 blocker) — a live revival catches before any spawn', () => {
  it('(a) a live session for the topic ⇒ live-session-exists, ZERO respawn', async () => {
    writeRun(42, 86400, new Date().toISOString());
    const h = harness();
    h.queue.considerEnqueue(candidate());
    (h.deps as Record<string, (t: number, v: boolean) => void>).__setLive(42, true);
    await warmCalm(h.drainer, 2);
    const r = await h.drainer.tick();
    expect(r.invalidated).toBe(1);
    expect(h.respawns).toHaveLength(0);
    expect(h.audits.find((a) => a.event === 'invalidated')?.why).toBe('live-session-exists');
  });

  it('(b) the topic resume UUID moved on (a message-revive) ⇒ resume-uuid-stale, ZERO respawn', async () => {
    writeRun(42, 86400, new Date().toISOString());
    const h = harness();
    h.queue.considerEnqueue(candidate());
    (h.deps as Record<string, (u: string | null) => void>).__setUuid('22222222-2222-4222-8222-222222222222');
    await warmCalm(h.drainer, 2);
    const r = await h.drainer.tick();
    expect(r.invalidated).toBe(1);
    expect(h.respawns).toHaveLength(0);
    expect(h.audits.find((a) => a.event === 'invalidated')?.why).toBe('resume-uuid-stale');
  });
});

describe('lease lens — only the owning machine drains', () => {
  it('topicOwnerElsewhere ⇒ topic-owner-elsewhere, ZERO respawn', async () => {
    writeRun(42, 86400, new Date().toISOString());
    const h = harness();
    h.queue.considerEnqueue(candidate());
    (h.deps as Record<string, (v: boolean) => void>).__setOwnerElsewhere(true);
    await warmCalm(h.drainer, 2);
    const r = await h.drainer.tick();
    expect(r.invalidated).toBe(1);
    expect(h.respawns).toHaveLength(0);
    expect(h.audits.find((a) => a.event === 'invalidated')?.why).toBe('topic-owner-elsewhere');
  });
});

describe('revival-loop lens — the resurrection cap halts an age-reap loop LOUDLY', () => {
  it('age-reap → revive → re-age-reap … hits resurrection-cap exactly once', async () => {
    writeRun(42, 86400, new Date().toISOString());
    const h = harness();

    // maxResurrections = 2: two successful revivals, the THIRD re-reap is capped.
    // Revival 1.
    expect(h.queue.considerEnqueue(candidate()).enqueued).toBe(true);
    await warmCalm(h.drainer, 2);
    expect((await h.drainer.tick()).resumed).toBe(true);

    // Re-age-reap (same stableKey topic:42) ⇒ revival 2.
    expect(h.queue.considerEnqueue(candidate()).enqueued).toBe(true);
    expect((await h.drainer.tick()).resumed).toBe(true);

    // Re-age-reap again ⇒ now over the cap.
    const capped = h.queue.considerEnqueue(candidate());
    expect(capped.enqueued).toBe(false);
    expect(capped.why).toBe('resurrection-cap');

    // LOUD: exactly one aggregated resurrection-cap notice.
    const capNotices = h.aggregated.filter((a) => a.kind === 'resurrection-cap');
    expect(capNotices).toHaveLength(1);
  });

  it('the injected build-or-autonomous-active evidence CANNOT reset the tombstone', async () => {
    // The cap reads tombstoneFor(stableKey), never workEvidence — so the synthetic
    // evidence on an age-limit entry shares the topic's tombstone and is capped.
    writeRun(7, 86400, new Date().toISOString());
    const h = harness();
    const c = () => candidate({ topicId: 7, tmuxSession: 't7' });
    h.queue.considerEnqueue(c());
    await warmCalm(h.drainer, 2);
    await h.drainer.tick(); // revive 1
    h.queue.considerEnqueue(c());
    await h.drainer.tick(); // revive 2
    expect(h.queue.considerEnqueue(c()).why).toBe('resurrection-cap');
  });
});
