// safe-git-allow: test-tmpdir-cleanup — afterEach removes the per-test mkdtempSync dir.
/**
 * E2E — GAP-B: an unregistered-but-committed autonomous run survives an age-limit
 * reap, AND the revive-loop is BOUNDED (spec §7 e2e + the 2026-06-13 regression).
 *
 * "Feature alive" tier-3 for a route-less feature: it drives the REAL ResumeQueue
 * + ResumeQueueDrainer (the same units the server wires) through the GAP-B
 * decision path, end to end:
 *
 *   1. A fresh open agent-commitment + recent user activity on an UNregistered
 *      topic → the GAP-B decision injects → the candidate is resume-eligible →
 *      the drainer respawns it (the run SURVIVES the age-limit reap).
 *   2. The resurrection cap bounds kill→revive→kill: after maxResurrections in
 *      the window the queue refuses (no infinite loop — P19 + 2026-06-13).
 *   3. ANTI-LOOP: with NO recent user message the GAP-B decision NEVER injects, so
 *      the candidate is never even enqueued — KEEP and eligibility agree, the loop
 *      cannot start.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ResumeQueue } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer, type ResumeQueueDrainerDeps } from '../../src/monitoring/ResumeQueueDrainer.js';
import { COMMITMENT_ACTIVE_RUN_REASON } from '../../src/core/WorkEvidence.js';
import {
  gapBEligibleForTopic,
  resolveGapBInjectionGate,
  decideGapBInjection,
} from '../../src/core/gapBCommitmentEvidence.js';

const TOPIC = 8801;
const OWN = 'machine-A';
const FRESH = 6 * 60 * 60_000;
const STALE = 8 * 60 * 60_000;

interface H {
  dir: string;
  tracker: CommitmentTracker;
  queue: ResumeQueue;
  drainer: ResumeQueueDrainer;
  respawns: string[];
  nowMs: () => number;
  advance: (ms: number) => void;
  cleanup: () => void;
}

function mk(over?: { recentUser?: boolean }): H {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapb-e2e-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ updates: { autoApply: true } }));
  let now = 5_000_000_000_000;
  const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir), originMachineId: OWN });
  const queue = new ResumeQueue(
    { stateDir: dir, audit: () => {}, raiseAggregated: () => {}, now: () => now },
    { dryRun: false, maxResurrections: 2 },
  );
  queue.start();
  const respawns: string[] = [];
  const recentUser = over?.recentUser ?? true;
  const deps: ResumeQueueDrainerDeps = {
    queue,
    pressureTier: () => 'normal',
    canSpawnSession: () => true,
    sessionCountOk: () => true,
    migrationInFlight: () => false,
    liveSessionForTopic: () => false,
    currentResumeUuid: () => null,
    topicOwnerElsewhere: () => false,
    topicBindingMatches: () => true,
    operatorStopSince: () => false,
    // GAP-B D9: re-validate the commitment liveness at drain (same verdict as enqueue).
    commitmentStillActiveForTopic: (topicId) =>
      gapBEligibleForTopic(topicId, tracker, {
        ownMachineId: OWN, freshCommitmentWindowMs: FRESH, staleCommitmentWindowMs: STALE,
        recentUserMessage: () => recentUser,
      }),
    jobCheck: () => ({ ok: true }),
    pathExists: () => true,
    respawnTopic: async (entry) => { respawns.push(entry.id); return `respawned-${entry.tmuxSession}`; },
    triggerJob: async () => 'triggered',
    spawnAliveAfterGrace: async () => true,
    notifyResumed: () => {},
    raiseAggregated: () => {},
    audit: () => {},
    now: () => now,
  };
  const drainer = new ResumeQueueDrainer(deps, { requiredCalmTicks: 1, attemptBackoffMs: 1000 });
  return {
    dir, tracker, queue, drainer, respawns,
    nowMs: () => now, advance: (ms) => { now += ms; },
    cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/gapB-unregistered-run-survives-lifecycle.test.ts' }),
  };
}

function freshCommitment(h: H): void {
  const c = h.tracker.record({ userRequest: 'go autonomous', agentResponse: 'on it', type: 'one-time-action', topicId: TOPIC });
  h.tracker.getAll().find((x) => x.id === c.id)!.createdAt = new Date(h.nowMs() - 60 * 60_000).toISOString();
}

/** The server's enqueue compose: GAP-B decision → candidate → considerEnqueue. */
function reapWithGapB(h: H, recentUser: boolean): { enqueued: boolean } {
  const eligible = gapBEligibleForTopic(TOPIC, h.tracker, {
    ownMachineId: OWN, freshCommitmentWindowMs: FRESH, staleCommitmentWindowMs: STALE,
    recentUserMessage: () => recentUser,
  });
  const decision = decideGapBInjection({
    gate: resolveGapBInjectionGate({ enabled: true, dryRun: false }),
    reason: 'age-limit', stateFilePresent: false, eligible,
  });
  if (!decision.inject) return { enqueued: false };
  const res = h.queue.considerEnqueue({
    sessionName: 'topic-8801', tmuxSession: 'agent-topic-8801', topicId: TOPIC,
    cwd: h.dir, reason: COMMITMENT_ACTIVE_RUN_REASON, disposition: 'terminal',
    origin: 'autonomous', workEvidence: ['build-or-autonomous-active'],
  });
  return { enqueued: res.enqueued };
}

async function warmDrain(h: H): Promise<void> {
  await h.drainer.tick(); // requiredCalmTicks:1 → this tick gates+drains
}

describe('GAP-B e2e — an unregistered-but-committed run SURVIVES an age-limit reap', () => {
  let h: H;
  beforeEach(() => { h = mk(); });
  afterEach(() => h.cleanup());

  it('fresh commitment + recent user activity ⇒ enqueued AND respawned (survives)', async () => {
    freshCommitment(h);
    expect(reapWithGapB(h, true).enqueued).toBe(true);
    await warmDrain(h);
    expect(h.respawns).toHaveLength(1);
  });
});

describe('GAP-B e2e — the revive-loop is BOUNDED (P19 + 2026-06-13 resurrection cap)', () => {
  let h: H;
  beforeEach(() => { h = mk(); });
  afterEach(() => h.cleanup());

  it('repeated reap→revive halts at maxResurrections (never an infinite loop)', async () => {
    freshCommitment(h);
    let enqueues = 0;
    // Drive kill→revive cycles well past the cap.
    for (let i = 0; i < 6; i++) {
      const r = reapWithGapB(h, true);
      if (r.enqueued) {
        enqueues++;
        await warmDrain(h);
      }
      h.advance(60_000); // a minute between cycles (well inside the 24h window)
    }
    // maxResurrections:2 ⇒ the queue stops enqueuing after the cap; the loop is bounded.
    expect(enqueues).toBeLessThanOrEqual(3); // initial + ≤2 resurrections
    expect(h.respawns.length).toBeLessThanOrEqual(3);
  });
});

describe('GAP-B e2e — ANTI-LOOP: no recent user message ⇒ never enqueued (KEEP/eligibility agree)', () => {
  let h: H;
  beforeEach(() => { h = mk({ recentUser: false }); });
  afterEach(() => h.cleanup());

  it('a fresh commitment but NO recent user message ⇒ the loop never starts', async () => {
    freshCommitment(h);
    for (let i = 0; i < 4; i++) {
      expect(reapWithGapB(h, false).enqueued).toBe(false); // never injects
      await warmDrain(h);
      h.advance(60_000);
    }
    expect(h.respawns).toHaveLength(0);
  });
});
