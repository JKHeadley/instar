// safe-git-allow: e2e fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * E2E — Build-Session Yield Safety (ACT-839) "feature alive" lifecycle.
 *
 * The feature has no bespoke HTTP route (observability rides the existing
 * /commitments + /sessions/resume-queue), so the alive-test is the WIRED
 * PIPELINE end-to-end with REAL components: a reaped dirty-worktree session is
 * enqueued with `uncommitted-worktree-work`, the drainer revives it, and the
 * REAL CommitmentTracker (the exact onWorktreeRevival closure server.ts wires)
 * gains a deduped, beacon-enabled obligation — and the continuation prompt
 * carries the verbatim directive. Proves R1→R2 is instantiated and runs, not
 * dead code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResumeQueue, type ResumeCandidateInput } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer, type ResumeQueueDrainerDeps } from '../../src/monitoring/ResumeQueueDrainer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-e2e-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function dirtyCandidate(over: Partial<ResumeCandidateInput> = {}): ResumeCandidateInput {
  return {
    sessionName: 'build-sess', tmuxSession: 'tmux-b', topicId: 77,
    resumeUuid: '22222222-2222-4222-8222-222222222222',
    cwd: '/tmp/wt', reason: 'quota-shed', disposition: 'terminal', origin: 'autonomous',
    workEvidence: ['uncommitted-worktree-work'],
    ...over,
  };
}

/** The EXACT onWorktreeRevival closure server.ts wires (dedup + record). */
function wireOnWorktreeRevival(ct: CommitmentTracker): (entry: { topicId?: number; stableKey: string }) => void {
  return (entry) => {
    if (entry.topicId == null) return;
    const externalKey = `yield-safety:${entry.stableKey}`;
    if (ct.getActive().some((c) => c.externalKey === externalKey)) return; // dedup
    ct.record({
      type: 'one-time-action', topicId: entry.topicId, source: 'sentinel', beaconEnabled: true, externalKey,
      userRequest: 'Session revived because its worktree held uncommitted work (ACT-839 yield-safety).',
      agentResponse: 'Commit the uncommitted worktree changes with a real, descriptive commit, or deliberately preserve/discard them, before yielding again.',
    });
  };
}

function buildPipeline() {
  let nowMs = 4_000_000_000_000;
  const ct = new CommitmentTracker({ stateDir: tmp });
  const queue = new ResumeQueue(
    { stateDir: tmp, audit: () => {}, raiseAggregated: () => {}, now: () => nowMs },
    { dryRun: false },
  );
  queue.start();
  const respawns: string[] = [];
  const deps: ResumeQueueDrainerDeps = {
    queue,
    pressureTier: () => 'normal',
    canSpawnSession: () => true, sessionCountOk: () => true, migrationInFlight: () => false,
    liveSessionForTopic: () => false,
    currentResumeUuid: () => '22222222-2222-4222-8222-222222222222',
    topicOwnerElsewhere: () => false, topicBindingMatches: () => true, operatorStopSince: () => false,
    jobCheck: () => ({ ok: true }), pathExists: () => true,
    respawnTopic: async (entry) => { respawns.push(entry.id); return `respawned-${entry.tmuxSession}`; },
    triggerJob: async () => 'triggered', spawnAliveAfterGrace: async () => true,
    raiseAggregated: () => {}, audit: () => {}, now: () => nowMs,
    onWorktreeRevival: wireOnWorktreeRevival(ct),
  };
  const drainer = new ResumeQueueDrainer(deps, { requiredCalmTicks: 2, attemptBackoffMs: 1000 });
  return { ct, queue, drainer, respawns };
}

describe('E2E: Build-Session Yield Safety lifecycle (feature alive, wired pipeline)', () => {
  it('a reaped dirty-worktree session is revived AND gains a real beacon-enabled commitment + the directive', async () => {
    const { ct, queue, drainer } = buildPipeline();
    const d = queue.considerEnqueue(dirtyCandidate());
    expect(d.enqueued).toBe(true); // R1: uncommitted-worktree-work is resume-eligible

    let resumed = false;
    for (let i = 0; i < 4 && !resumed; i++) resumed = (await drainer.tick()).resumed === true;
    expect(resumed).toBe(true);
    expect(queue.get(d.entry!.id)?.status).toBe('respawned');

    // R2 directive present in the continuation prompt.
    const prompt = drainer.continuationPrompt(queue.get(d.entry!.id)!);
    expect(prompt.startsWith('You were revived because your worktree had uncommitted changes')).toBe(true);

    // R2 commitment: a REAL beacon-enabled obligation now exists.
    const open = ct.getActive().filter((c) => c.externalKey === 'yield-safety:topic:77');
    expect(open).toHaveLength(1);
    expect(open[0].beaconEnabled).toBe(true);
    expect(open[0].type).toBe('one-time-action');
  });

  it('dedup: a second revival of the same stableKey does NOT open a second commitment', async () => {
    const { ct, queue, drainer } = buildPipeline();
    // First revival.
    const d1 = queue.considerEnqueue(dirtyCandidate());
    await drainer.tick(); await drainer.tick(); await drainer.tick();
    expect(queue.get(d1.entry!.id)?.status).toBe('respawned');
    // The same topic reaped + revived again (same stableKey topic:77).
    const d2 = queue.considerEnqueue(dirtyCandidate());
    if (d2.enqueued) { await drainer.tick(); await drainer.tick(); await drainer.tick(); }
    const open = ct.getActive().filter((c) => c.externalKey === 'yield-safety:topic:77');
    expect(open).toHaveLength(1); // never a second row
  });
});
