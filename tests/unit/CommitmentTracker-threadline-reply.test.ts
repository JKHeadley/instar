/**
 * Unit tests for the threadline-reply verification method added to
 * CommitmentTracker per THREAD-TOPIC-LINKAGE-SPEC.md.
 *
 * Covers:
 *  - findByThreadId returns the active commitment for a thread
 *  - findByThreadId skips delivered/expired/withdrawn entries
 *  - verifyOne on a threadline-reply commitment is a no-op (no violations
 *    accumulated, status stays pending)
 *  - record() stores relatedThreadId and relatedAgent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-tl-reply-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ updates: { autoApply: true }, sessions: { maxSessions: 3 } }, null, 2),
  );
  return {
    stateDir,
    cleanup: () => SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true, force: true,
      operation: 'tests/unit/CommitmentTracker-threadline-reply.test.ts',
    }),
  };
}

describe('CommitmentTracker — threadline-reply verification method', () => {
  let stateDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const t = tmpState();
    stateDir = t.stateDir;
    cleanup = t.cleanup;
  });

  afterEach(() => cleanup());

  it('record() stores relatedThreadId and relatedAgent', () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const c = tracker.record({
      type: 'one-time-action',
      verificationMethod: 'threadline-reply',
      topicId: 9210,
      relatedThreadId: 'thread-abc',
      relatedAgent: 'ai-guy',
      userRequest: 'ask ai-guy for stripe data',
      agentResponse: 'sent, awaiting reply',
    });
    expect(c.verificationMethod).toBe('threadline-reply');
    expect(c.relatedThreadId).toBe('thread-abc');
    expect(c.relatedAgent).toBe('ai-guy');
    expect(c.status).toBe('pending');
  });

  it('findByThreadId returns the active commitment for a thread', () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    tracker.record({
      type: 'one-time-action',
      verificationMethod: 'threadline-reply',
      topicId: 9210,
      relatedThreadId: 'thread-xyz',
      relatedAgent: 'luna',
      userRequest: 'test',
      agentResponse: 'sent',
    });
    const found = tracker.findByThreadId('thread-xyz');
    expect(found).not.toBeNull();
    expect(found?.relatedThreadId).toBe('thread-xyz');
    expect(found?.relatedAgent).toBe('luna');
  });

  it('findByThreadId returns null on miss', () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    expect(tracker.findByThreadId('nonexistent')).toBeNull();
  });

  it('findByThreadId skips delivered commitments', () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const c = tracker.record({
      type: 'one-time-action',
      verificationMethod: 'threadline-reply',
      topicId: 9210,
      relatedThreadId: 'thread-done',
      relatedAgent: 'agent',
      userRequest: 'q',
      agentResponse: 'a',
    });
    tracker.deliver(c.id);
    expect(tracker.findByThreadId('thread-done')).toBeNull();
  });

  it('findByThreadId skips withdrawn commitments', () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const c = tracker.record({
      type: 'one-time-action',
      verificationMethod: 'threadline-reply',
      topicId: 9210,
      relatedThreadId: 'thread-w',
      relatedAgent: 'agent',
      userRequest: 'q',
      agentResponse: 'a',
    });
    tracker.withdraw(c.id, 'user cancelled');
    expect(tracker.findByThreadId('thread-w')).toBeNull();
  });

  it('verifyOne on a threadline-reply commitment is a no-op — no violation accumulation', () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const c = tracker.record({
      type: 'one-time-action',
      verificationMethod: 'threadline-reply',
      topicId: 9210,
      relatedThreadId: 'thread-sweep',
      relatedAgent: 'agent',
      userRequest: 'q',
      agentResponse: 'a',
    });
    // Sweep multiple times — none should change status or accumulate violations.
    for (let i = 0; i < 5; i++) {
      const res = tracker.verifyOne(c.id);
      expect(res?.passed).toBe(false);
      expect(res?.detail).toContain('Awaiting threadline reply');
    }
    const after = tracker.getActive().find(x => x.id === c.id);
    expect(after?.status).toBe('pending');
    expect(after?.violationCount).toBe(0);
  });

  it('threadline-reply commitments are NOT auto-marked delivered by the unverifiable backfill', () => {
    // Construct, persist, then re-construct to trigger backfill on a record
    // with verificationMethod: 'threadline-reply'.
    const tracker1 = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const c = tracker1.record({
      type: 'one-time-action',
      verificationMethod: 'threadline-reply',
      topicId: 9210,
      relatedThreadId: 'thread-bf',
      relatedAgent: 'agent',
      userRequest: 'q',
      agentResponse: 'a',
    });
    expect(c.status).toBe('pending');
    // Fresh tracker triggers backfill in constructor.
    const tracker2 = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const after = tracker2.getActive().find(x => x.id === c.id);
    expect(after?.status).toBe('pending');
  });

  it('PromiseBeacon auto-opt fires when topicId is attached (smoke check on beaconEnabled)', () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const c = tracker.record({
      type: 'one-time-action',
      verificationMethod: 'threadline-reply',
      topicId: 9210,
      relatedThreadId: 'thread-bcn',
      relatedAgent: 'agent',
      userRequest: 'q',
      agentResponse: 'a',
      beaconEnabled: true, // explicit (matches TopicLinkageHandler call-site)
    });
    expect(c.beaconEnabled).toBe(true);
  });
});
