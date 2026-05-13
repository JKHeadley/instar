/**
 * Unit tests for PromiseBeacon UX fixes:
 *  - Heartbeat messages include a "re: <promise excerpt>" suffix.
 *  - After N consecutive unchanged-snapshot cycles, the beacon auto-pauses,
 *    emits a single final "auto-paused — reply 'keep watching' to resume"
 *    message, and stops firing. Status stays `pending`.
 *  - Resume clears the paused flag, resets the counter, and re-arms.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { PromiseBeacon } from '../../src/monitoring/PromiseBeacon.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-beacon-ux-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  return { dir, cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PromiseBeacon-ux-fixes.test.ts:21' }) };
}

function baseTracker(dir: string) {
  return new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
}

describe('PromiseBeacon — UX fixes', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => { ({ dir, cleanup } = tmpState()); });
  afterEach(() => cleanup());

  it('appends a "re: <promise excerpt>" suffix to every templated heartbeat', async () => {
    const tracker = baseTracker(dir);
    const sent: Array<{ text: string }> = [];
    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'static\noutput',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (_topicId, text) => { sent.push({ text }); },
      defaultAutoPauseAfterUnchanged: 0, // disable auto-pause for this test
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'ship the thing',
      agentResponse: 'Sent threadline message to luna, awaiting reply.',
      topicId: 42,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });

    // First fire seeds the hash; second fire hits the templated branch.
    await beacon.fire(c.id);
    await beacon.fire(c.id);

    expect(sent.length).toBe(2);
    expect(sent[1].text).toContain('re: Sent threadline message to luna, awaiting reply.');
    beacon.stop();
  });

  it('auto-pauses after N consecutive unchanged-snapshot heartbeats and emits a final resume hint', async () => {
    const tracker = baseTracker(dir);
    const sent: Array<{ text: string }> = [];
    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'identical output',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (_topicId, text) => { sent.push({ text }); },
      defaultAutoPauseAfterUnchanged: 3,
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'watch a quiet build',
      agentResponse: 'will keep an eye on the build',
      topicId: 99,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });

    // Fire enough times to cross the threshold. Each fire after the first
    // sees an unchanged snapshot.
    for (let i = 0; i < 6; i++) {
      await beacon.fire(c.id);
    }

    // Last message should be the auto-pause notice.
    const last = sent[sent.length - 1].text;
    expect(last).toMatch(/auto-paused/i);
    expect(last).toMatch(/keep watching/i);
    expect(last).toContain('re: will keep an eye on the build');

    // Commitment is paused but not terminal.
    const after = tracker.getAll().find(x => x.id === c.id)!;
    expect(after.status).toBe('pending');
    expect(after.beaconPaused).toBe(true);
    expect(after.beaconPausedReason).toBe('auto-paused-no-progress');
    expect(after.beaconPausedAt).toBeDefined();

    // Further fires must not produce more messages.
    const beforeCount = sent.length;
    await beacon.fire(c.id);
    expect(sent.length).toBe(beforeCount);

    beacon.stop();
  });

  it('resume() clears paused flag, resets counter, and emits a resumed event', async () => {
    const tracker = baseTracker(dir);
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'x',
      agentResponse: 'y',
      topicId: 7,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    // Simulate auto-pause state.
    await tracker.mutate(c.id, prev => ({
      ...prev,
      beaconPaused: true,
      beaconPausedReason: 'auto-paused-no-progress',
      beaconPausedAt: new Date().toISOString(),
      consecutiveUnchanged: 42,
    }));

    const events: string[] = [];
    tracker.on('resumed', (updated) => events.push(updated.id));

    const updated = tracker.resume(c.id);
    expect(updated).not.toBeNull();
    expect(updated!.beaconPaused).toBeFalsy();
    expect(updated!.beaconPausedReason).toBeUndefined();
    expect(updated!.beaconPausedAt).toBeUndefined();
    expect(updated!.consecutiveUnchanged).toBe(0);
    expect(events).toEqual([c.id]);
  });

  it('resume() returns null for non-paused or terminal commitments', () => {
    const tracker = baseTracker(dir);
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'x',
      agentResponse: 'y',
      topicId: 7,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    // Not paused → null.
    expect(tracker.resume(c.id)).toBeNull();

    // Withdrawn → null even if some other state existed.
    tracker.withdraw(c.id, 'test');
    expect(tracker.resume(c.id)).toBeNull();
  });

  it('auto-pauses by default within ~5 fires when no threshold override is configured', async () => {
    const tracker = baseTracker(dir);
    const sent: Array<{ text: string }> = [];
    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'identical output',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (_topicId, text) => { sent.push({ text }); },
      // intentionally no defaultAutoPauseAfterUnchanged — exercise the default.
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'watch a quiet build',
      agentResponse: 'will keep an eye on the build',
      topicId: 99,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });

    // Fire well past the default threshold; expect a pause before fire 7.
    for (let i = 0; i < 10; i++) {
      await beacon.fire(c.id);
    }

    const pauseIndex = sent.findIndex(m => /auto-paused/i.test(m.text));
    expect(pauseIndex).toBeGreaterThan(0);
    // Default is 4 unchanged cycles: with seed-fire counted, pause lands no
    // later than the 6th sent message (seed + 4 unchanged + pause). The bound
    // is intentionally loose so it doesn't go off-target on small refactors,
    // but it MUST be tighter than the previous default of 12.
    expect(pauseIndex).toBeLessThanOrEqual(6);

    beacon.stop();
  });

  it('a resumed beacon re-arms via the resumed event handler', async () => {
    const tracker = baseTracker(dir);
    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'x',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async () => {},
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'x',
      agentResponse: 'y',
      topicId: 11,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    // Put it into paused state directly.
    await tracker.mutate(c.id, prev => ({ ...prev, beaconPaused: true, beaconPausedReason: 'auto-paused-no-progress' }));
    beacon.stopFor(c.id);
    expect(beacon.getScheduledIds()).not.toContain(c.id);

    tracker.resume(c.id);
    // Resume event handler must have re-armed the timer.
    expect(beacon.getScheduledIds()).toContain(c.id);

    beacon.stop();
  });
});
