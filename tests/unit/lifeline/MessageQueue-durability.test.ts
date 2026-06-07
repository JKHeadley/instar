/**
 * MessageQueue durability — closes the 2026-06-06 topic-21487 untracked-loss.
 *
 * Failure shape: replayQueue used drain(), which emptied the on-disk queue up
 * front and held the messages only in memory. A process exit mid-replay
 * (update / version-skew / launchd restart — common during the exact episodes
 * that trigger queuing) lost the undelivered messages with NO record — not
 * delivered, not re-queued, not in dropped-messages.json. The user's real
 * question simply vanished.
 *
 * Fix: durable consume — a message leaves the persisted queue only via
 * remove() (after delivery/drop). updateReplayCounters() persists strike
 * counts in place. An exit mid-replay leaves undelivered messages on disk for
 * the next replay.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageQueue, type QueuedMessage } from '../../../src/lifeline/MessageQueue.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let stateDir: string;

function msg(id: string, topicId = 100): QueuedMessage {
  return {
    id,
    topicId,
    text: `text-${id}`,
    fromUserId: 1,
    fromFirstName: 'Justin',
    timestamp: '2026-06-06T02:08:00.000Z',
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-durability-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/lifeline/MessageQueue-durability.test.ts:afterEach',
  });
});

describe('MessageQueue.remove', () => {
  it('removes only the targeted message and persists to disk', () => {
    const q = new MessageQueue(stateDir);
    q.enqueue(msg('tg-1'));
    q.enqueue(msg('tg-2'));
    q.enqueue(msg('tg-3'));

    expect(q.remove('tg-2')).toBe(true);
    expect(q.peek().map(m => m.id)).toEqual(['tg-1', 'tg-3']);

    // Persisted: a fresh queue on the same dir (a new process) sees the change.
    const reopened = new MessageQueue(stateDir);
    expect(reopened.peek().map(m => m.id)).toEqual(['tg-1', 'tg-3']);
  });

  it('returns false and changes nothing for an unknown id', () => {
    const q = new MessageQueue(stateDir);
    q.enqueue(msg('tg-1'));
    expect(q.remove('tg-nope')).toBe(false);
    expect(q.peek().map(m => m.id)).toEqual(['tg-1']);
  });
});

describe('MessageQueue.updateReplayCounters', () => {
  it('patches strike counters in place and persists; message stays queued', () => {
    const q = new MessageQueue(stateDir);
    q.enqueue(msg('tg-1'));

    q.updateReplayCounters('tg-1', { replayFailures: 1, transientReplayFailures: 4 });

    const reopened = new MessageQueue(stateDir);
    const got = reopened.peek()[0];
    expect(got.id).toBe('tg-1'); // still on disk
    expect(got.replayFailures).toBe(1);
    expect(got.transientReplayFailures).toBe(4);
  });

  it('is a no-op for an unknown id (no throw)', () => {
    const q = new MessageQueue(stateDir);
    q.enqueue(msg('tg-1'));
    expect(() =>
      q.updateReplayCounters('tg-gone', { replayFailures: 9, transientReplayFailures: 9 }),
    ).not.toThrow();
    expect(q.peek()[0].replayFailures).toBeUndefined();
  });
});

describe('durable consume survives a mid-replay process exit', () => {
  it('delivering one message and exiting leaves the rest on disk (no untracked loss)', () => {
    // Replay handles tg-1 (delivered → remove), then the process dies before
    // tg-2/tg-3 are touched. The persisted queue must still hold tg-2, tg-3.
    const q = new MessageQueue(stateDir);
    q.enqueue(msg('tg-1'));
    q.enqueue(msg('tg-2'));
    q.enqueue(msg('tg-3'));

    // Snapshot (peek, NOT drain) — disk still holds all three.
    const snapshot = q.peek();
    expect(snapshot).toHaveLength(3);

    // Deliver the first, then "crash" — simulate by constructing a brand-new
    // queue from the same dir, as a restarted process would.
    q.remove('tg-1');

    const afterRestart = new MessageQueue(stateDir);
    expect(afterRestart.peek().map(m => m.id)).toEqual(['tg-2', 'tg-3']);
  });

  it('a transient failure persists the strike but keeps the message recoverable after restart', () => {
    const q = new MessageQueue(stateDir);
    q.enqueue(msg('tg-1'));

    // Transient failure → bump transient counter in place, leave on disk.
    q.updateReplayCounters('tg-1', { replayFailures: 0, transientReplayFailures: 1 });

    // Process restarts before delivery — the message and its strike survive.
    const afterRestart = new MessageQueue(stateDir);
    const got = afterRestart.peek();
    expect(got.map(m => m.id)).toEqual(['tg-1']);
    expect(got[0].transientReplayFailures).toBe(1);
    expect(got[0].replayFailures).toBe(0); // poison budget never touched
  });
});
