// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * honest-session-state-surfaces Finding (c) — the split predicate.
 *
 * `hasLiveQueuedEntryFor` (OWNERSHIP, paused-BLIND) feeds the PromiseBeacon I2
 * double-spawn coordination guard and must stay TRUE while the queue is paused
 * (the queue still owns its frozen entry). `hasClaimableQueuedEntryFor`
 * (CLAIMABILITY = live AND !paused) feeds the user-facing "A restart is queued"
 * copy and must be FALSE while paused (a paused queue won't revive yet, so the
 * claim would be a promise it cannot currently keep).
 *
 * These tests pin BOTH sides of the boundary — including the I2-guard regression
 * assertion that ownership survives a pause.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ResumeQueue,
  type ResumeCandidateInput,
} from '../../src/monitoring/ResumeQueue.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-claimable-test-'));
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

function makeQueue(cfg?: Partial<import('../../src/monitoring/ResumeQueue.js').ResumeQueueConfig>) {
  let nowMs = 3_000_000_000_000;
  const q = new ResumeQueue(
    {
      stateDir: tmpDir,
      audit: () => {},
      raiseAggregated: () => {},
      now: () => nowMs,
    },
    { dryRun: false, ...cfg },
  );
  return q;
}

describe('ResumeQueue split predicate (Finding c)', () => {
  it('live entry, NOT paused → BOTH ownership and claimability are true', () => {
    const q = makeQueue();
    q.start();
    expect(q.considerEnqueue(candidate()).enqueued).toBe(true);

    expect(q.hasLiveQueuedEntryFor('tmux-1')).toBe(true);
    expect(q.hasClaimableQueuedEntryFor('tmux-1')).toBe(true);
  });

  it('PAUSED → claimability FALSE (copy suppressed) while ownership stays TRUE (I2 guard preserved)', () => {
    const q = makeQueue();
    q.start();
    expect(q.considerEnqueue(candidate()).enqueued).toBe(true);

    q.pause('emergency-stop');

    // The user-facing "restart is queued" copy must NOT claim a revival.
    expect(q.hasClaimableQueuedEntryFor('tmux-1')).toBe(false);
    // …but the queue STILL owns the frozen topic — the PromiseBeacon I2
    // double-spawn coordination guard reads this and must keep deferring.
    expect(q.hasLiveQueuedEntryFor('tmux-1')).toBe(true);
  });

  it('after unpause → claimability returns to true (entry preserved across the pause)', () => {
    const q = makeQueue();
    q.start();
    expect(q.considerEnqueue(candidate()).enqueued).toBe(true);

    q.pause('emergency-stop');
    expect(q.hasClaimableQueuedEntryFor('tmux-1')).toBe(false);

    q.unpause();
    expect(q.hasClaimableQueuedEntryFor('tmux-1')).toBe(true);
    expect(q.hasLiveQueuedEntryFor('tmux-1')).toBe(true);
  });

  it('dryRun → BOTH predicates false (existing guard unbroken on both)', () => {
    const q = makeQueue({ dryRun: true });
    q.start();
    q.considerEnqueue(candidate());

    expect(q.hasLiveQueuedEntryFor('tmux-1')).toBe(false);
    expect(q.hasClaimableQueuedEntryFor('tmux-1')).toBe(false);
  });

  it('disabled (enabled:false) → BOTH predicates false', () => {
    const q = makeQueue({ enabled: false });
    // No start() needed — the enabled guard fires before any entry can exist.
    expect(q.hasLiveQueuedEntryFor('tmux-1')).toBe(false);
    expect(q.hasClaimableQueuedEntryFor('tmux-1')).toBe(false);
  });

  it('unknown session → both false even when paused', () => {
    const q = makeQueue();
    q.start();
    q.considerEnqueue(candidate());
    q.pause('emergency-stop');

    expect(q.hasLiveQueuedEntryFor('not-a-session')).toBe(false);
    expect(q.hasClaimableQueuedEntryFor('not-a-session')).toBe(false);
  });
});
