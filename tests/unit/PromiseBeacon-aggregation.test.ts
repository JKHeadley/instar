/**
 * Tier 1 semantic coverage for topic-level PromiseBeacon aggregation.
 *
 * The invariant is user-surface cardinality, not per-commitment correctness:
 * one topic emits at most one summary per aggregate cadence, while every
 * qualifying commitment remains represented in a durable count+list batch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CommitmentTracker, type Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { PromiseBeacon } from '../../src/monitoring/PromiseBeacon.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import type { DeliveryOutcome } from '../../src/core/deliverToConversation.js';

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-beacon-aggregate-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  return {
    dir,
    cleanup: () => SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PromiseBeacon-aggregation.test.ts:tmpState',
    }),
  };
}

function record(
  tracker: CommitmentTracker,
  label: string,
  topicId = 77,
  cadenceMs = 60_000,
): Commitment {
  return tracker.record({
    type: 'one-time-action',
    userRequest: `request ${label}`,
    agentResponse: `promise ${label}`,
    topicId,
    beaconEnabled: true,
    cadenceMs,
    nextUpdateDueAt: '2099-01-01T00:00:00Z',
  });
}

describe('PromiseBeacon — topic aggregation', () => {
  let dir: string;
  let cleanup: () => void;
  let now: number;
  let tracker: CommitmentTracker;
  let sent: Array<{ topicId: number; text: string }>;

  beforeEach(() => {
    ({ dir, cleanup } = tmpState());
    now = Date.parse('2026-07-30T20:00:00.000Z');
    tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
    sent = [];
  });
  afterEach(() => cleanup());

  function makeBeacon(output = () => 'live output'): PromiseBeacon {
    return new PromiseBeacon({
      userOutputEnabled: true,
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: output,
      getSessionForTopic: topicId => `session-${topicId}`,
      isSessionAlive: () => true,
      sendMessage: async (topicId, text) => { sent.push({ topicId, text }); },
      generateStatusLine: async promise => `news for ${promise}`,
      minCadenceMs: 1,
      now: () => now,
    });
  }

  it('bounds a same-topic burst by topic/cadence and carries every item in count+list summaries', async () => {
    const commitments = Array.from({ length: 12 }, (_, i) => record(tracker, `item-${i}`));
    const beacon = makeBeacon();
    beacon.start();

    for (const commitment of commitments) await beacon.fire(commitment.id);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('12 open');
    expect(sent[0].text).toContain('Open (12)');
    expect(sent[0].text).toContain('promise item-0');
    expect(sent[0].text).toContain('promise item-11');

    now += 60_000;
    await beacon.flushTopicAggregate(77);

    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain('11 qualifying updates');
    expect(sent[1].text).toContain('Updates (11)');
    beacon.stop();
  });

  it('mixed news uses one topic rhythm: highlights the new item and lists quiet siblings without claiming progress', async () => {
    const oldA = record(tracker, 'quiet-a');
    const oldB = record(tracker, 'quiet-b');
    const beacon = makeBeacon();
    beacon.start();

    // Establish both old commitments' snapshot baselines and drain their first
    // aggregate window.
    await beacon.fire(oldA.id);
    await beacon.fire(oldB.id);
    now += 60_000;
    await beacon.flushTopicAggregate(77);
    sent.length = 0;

    const newcomer = record(tracker, 'new-with-news');
    await beacon.fire(oldA.id); // unchanged → honest silence
    await beacon.fire(oldB.id); // unchanged → honest silence
    await beacon.fire(newcomer.id); // first snapshot → qualifying news

    expect(sent).toHaveLength(0);
    now += 60_000;
    await beacon.flushTopicAggregate(77);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('3 open; 1 qualifying update');
    expect(sent[0].text).toContain('promise quiet-a');
    expect(sent[0].text).toContain('promise quiet-b');
    expect(sent[0].text).toContain('promise new-with-news');
    expect(sent[0].text).toContain('Updates (1)');
    expect(sent[0].text).toContain('news for promise new-with-news');
    expect(sent[0].text).not.toContain('news for promise quiet-a');
    expect(sent[0].text).not.toContain('news for promise quiet-b');
    beacon.stop();
  });

  it('uses the shortest effective topic cadence and treats the exact boundary as due', async () => {
    const slow = record(tracker, 'five-minute', 77, 5 * 60_000);
    const fast = record(tracker, 'one-minute', 77, 60_000);
    const beacon = makeBeacon();
    beacon.start();

    await beacon.fire(slow.id);
    await beacon.fire(fast.id);
    expect(sent).toHaveLength(1);

    now += 59_999;
    expect(await beacon.flushTopicAggregate(77)).toBe('skipped');
    expect(sent).toHaveLength(1);

    now += 1;
    expect(await beacon.flushTopicAggregate(77)).toBe('sent');
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain('promise one-minute');
    beacon.stop();
  });

  it('keeps a queued qualifying item across restart and does not merge independent topics', async () => {
    const first = record(tracker, 'topic-77-a', 77);
    const queued = record(tracker, 'topic-77-b', 77);
    const otherA = record(tracker, 'topic-88-a', 88);
    const otherB = record(tracker, 'topic-88-b', 88);
    const firstBeacon = makeBeacon();
    firstBeacon.start();

    await firstBeacon.fire(first.id);
    await firstBeacon.fire(queued.id);
    await firstBeacon.fire(otherA.id);
    await firstBeacon.fire(otherB.id);
    expect(sent.map(message => message.topicId)).toEqual([77, 88]);
    firstBeacon.stop();

    now += 60_000;
    const restarted = makeBeacon();
    restarted.start();
    await restarted.flushTopicAggregate(77);
    await restarted.flushTopicAggregate(88);

    expect(sent.map(message => message.topicId)).toEqual([77, 88, 77, 88]);
    expect(sent[2].text).toContain('promise topic-77-b');
    expect(sent[3].text).toContain('promise topic-88-b');
    restarted.stop();
  });

  it('queues a terminal session-loss notice behind the same bound and delivers it at the next boundary', async () => {
    let epoch = 'epoch-1';
    const commitment = tracker.record({
      type: 'one-time-action',
      userRequest: 'finish the migration',
      agentResponse: 'I will finish the migration',
      topicId: 77,
      beaconEnabled: true,
      cadenceMs: 60_000,
      sessionEpoch: 'epoch-1',
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    const beacon = new PromiseBeacon({
      userOutputEnabled: true,
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'live output',
      getSessionForTopic: () => 'session-77',
      getSessionEpoch: () => epoch,
      isSessionAlive: () => true,
      sendMessage: async (topicId, text) => { sent.push({ topicId, text }); },
      minCadenceMs: 1,
      now: () => now,
    });
    beacon.start();

    await beacon.fire(commitment.id);
    expect(sent).toHaveLength(1);
    epoch = 'epoch-2';
    await beacon.fire(commitment.id);

    expect(tracker.get(commitment.id)?.status).toBe('violated');
    expect(sent).toHaveLength(1);

    now += 60_000;
    await beacon.flushTopicAggregate(77);
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toMatch(/violated|session-lost/);
    beacon.stop();
  });

  it('retries an ambiguous batch byte-identically and preserves newer qualifications for the following cadence', async () => {
    const first = record(tracker, 'ambiguous-first');
    const later = record(tracker, 'queued-later');
    const deliveries: Array<{ text: string; logicalSendId?: string }> = [];
    const outcomes: DeliveryOutcome[] = [
      { delivered: false, outcome: 'not-delivered', reason: 'send-failed', detail: 'ambiguous: socket hang up' },
      { delivered: true, outcome: 'delivered' },
      { delivered: true, outcome: 'delivered' },
    ];
    const beacon = new PromiseBeacon({
      userOutputEnabled: true,
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'live output',
      getSessionForTopic: topicId => `session-${topicId}`,
      isSessionAlive: () => true,
      sendMessage: async () => {},
      deliverMessage: async (_topicId, text, opts) => {
        deliveries.push({ text, logicalSendId: opts.logicalSendId });
        return outcomes.shift()!;
      },
      generateStatusLine: async promise => `news for ${promise}`,
      minCadenceMs: 1,
      now: () => now,
    });
    beacon.start();

    await beacon.fire(first.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].text).toContain('promise ambiguous-first');

    await beacon.fire(later.id);
    now += 60_000;
    await beacon.flushTopicAggregate(77);

    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(deliveries[1].text).not.toContain('news for promise queued-later');

    now += 60_000;
    await beacon.flushTopicAggregate(77);

    expect(deliveries).toHaveLength(3);
    expect(deliveries[2].text).toContain('news for promise queued-later');
    expect(deliveries[2].logicalSendId).not.toBe(deliveries[1].logicalSendId);
    beacon.stop();
  });

  it('rechecks owner visibility before flush so an agent-owned representative cannot suppress user-owned siblings', async () => {
    const lead = record(tracker, 'lead');
    const ownerChanges = record(tracker, 'becomes-agent-owned');
    const staysVisible = record(tracker, 'stays-user-owned');
    for (const commitment of [lead, ownerChanges, staysVisible]) {
      await tracker.mutate(commitment.id, previous => ({ ...previous, owner: 'user' }));
    }
    const beacon = new PromiseBeacon({
      userOutputEnabled: true,
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'live output',
      getSessionForTopic: topicId => `session-${topicId}`,
      isSessionAlive: () => true,
      sendMessage: async (topicId, text) => { sent.push({ topicId, text }); },
      generateStatusLine: async promise => `news for ${promise}`,
      agentOwnedFollowthrough: () => ({ enabled: true, dryRun: false }),
      minCadenceMs: 1,
      now: () => now,
    });
    beacon.start();

    await beacon.fire(lead.id);
    await beacon.fire(ownerChanges.id);
    await beacon.fire(staysVisible.id);
    expect(sent).toHaveLength(1);

    await tracker.mutate(ownerChanges.id, previous => ({ ...previous, owner: 'agent' }));
    now += 60_000;
    await beacon.flushTopicAggregate(77);

    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain('news for promise stays-user-owned');
    expect(sent[1].text).not.toContain('news for promise becomes-agent-owned');
    expect(sent[1].text).not.toContain('promise becomes-agent-owned');
    beacon.stop();
  });
});
