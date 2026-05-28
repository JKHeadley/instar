/**
 * Tier-1 unit tests for CollaborationRedriveEngine.
 *
 * Covers BOTH sides of every eligibility boundary, the durable reply-
 * independent cap (the round-1 adversarial fix), and restart-survival.
 * Spec: docs/specs/collaboration-redrive-on-counterpart-silence.md §2.4 + §2.7.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CollaborationRedriveEngine,
  DEFAULT_REDRIVE_CONFIG,
  jaccard3gram,
  referenceMs,
} from '../../src/monitoring/CollaborationRedriveEngine.js';
import { CommitmentTracker, type Commitment } from '../../src/monitoring/CommitmentTracker.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'collab-redrive-test-'));
}

function makeStubIntelligence(verdict: 'MET' | 'NOT_MET' = 'NOT_MET'): IntelligenceProvider {
  return {
    evaluate: vi.fn(async () => `${verdict}\nstub verdict for unit test`),
  } as unknown as IntelligenceProvider;
}

function makeKnownAgents(dir: string, agents: Array<{ name: string; publicKey: string }>): string {
  const p = path.join(dir, 'known-agents.json');
  fs.writeFileSync(p, JSON.stringify({ agents }, null, 2));
  return p;
}

function setupTracker(dir: string): CommitmentTracker {
  return new CommitmentTracker({ stateDir: dir, autoStartLoop: false });
}

function makeRelayStub(): {
  client: { sendPlaintext: (fp: string, text: string, threadId?: string) => string };
  sent: Array<{ fingerprint: string; text: string; threadId?: string }>;
} {
  const sent: Array<{ fingerprint: string; text: string; threadId?: string }> = [];
  return {
    client: {
      sendPlaintext: (fingerprint: string, text: string, threadId?: string) => {
        sent.push({ fingerprint, text, threadId });
        return `msg-${Date.now()}`;
      },
    },
    sent,
  };
}

function recordThreadlineReplyCommitment(
  tracker: CommitmentTracker,
  opts: { relatedAgent?: string; relatedThreadId?: string; lastReplyAt?: string } = {},
): Commitment {
  const c = tracker.record({
    userRequest: 'Dawn, please deploy /api/instar/read to Vercel',
    agentResponse: 'On it — will check back when deployed',
    type: 'one-time-action',
    topicId: 12476,
    verificationMethod: 'threadline-reply',
    relatedAgent: opts.relatedAgent ?? 'dawn',
    relatedThreadId: opts.relatedThreadId ?? 'thread-test-1',
  });
  if (opts.lastReplyAt) {
    tracker.markReplyArrived(c.id, opts.lastReplyAt);
  }
  return tracker.get(c.id)!;
}

describe('CollaborationRedriveEngine — eligibility (both sides of every boundary)', () => {
  let dir: string;
  let tracker: CommitmentTracker;
  let engine: CollaborationRedriveEngine;

  beforeEach(() => {
    dir = makeTmpDir();
    tracker = setupTracker(dir);
    engine = new CollaborationRedriveEngine(
      {
        commitmentTracker: tracker,
        completionEvaluator: new CompletionEvaluator({ intelligence: makeStubIntelligence() }),
        knownAgentsPath: makeKnownAgents(dir, [{ name: 'dawn', publicKey: 'fp-dawn-1' }]),
        now: () => Date.parse('2026-05-28T20:00:00Z'),
      },
      { ...DEFAULT_REDRIVE_CONFIG, enabled: true },
    );
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/CollaborationRedriveEngine.test.ts cleanup' });
  });

  it('rejects non-threadline-reply', () => {
    const c = tracker.record({
      userRequest: 'do thing', agentResponse: 'ok', type: 'one-time-action',
    });
    expect(engine.checkEligibility(c, Date.parse('2026-05-28T20:00:00Z')))
      .toEqual({ eligible: false, reason: 'not-threadline-reply' });
  });

  it('rejects terminal status (delivered)', async () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T18:00:00Z' });
    await tracker.mutate(c.id, (prev) => ({ ...prev, status: 'delivered' as const, resolvedAt: '2026-05-28T19:00:00Z' }));
    const updated = tracker.get(c.id)!;
    expect(engine.checkEligibility(updated, Date.parse('2026-05-28T20:00:00Z')).eligible).toBe(false);
  });

  it('rejects invalid (NaN) reference timestamp', () => {
    const c = recordThreadlineReplyCommitment(tracker);
    const bad = { ...c, lastReplyAt: 'not-a-date' } as Commitment;
    expect(engine.checkEligibility(bad, Date.parse('2026-05-28T20:00:00Z')))
      .toEqual({ eligible: false, reason: 'invalid-reference-timestamp' });
  });

  it('rejects future reference timestamp (clock skew)', () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2027-01-01T00:00:00Z' });
    expect(engine.checkEligibility(c, Date.parse('2026-05-28T20:00:00Z')))
      .toEqual({ eligible: false, reason: 'future-reference-timestamp' });
  });

  it('rejects silence below threshold', () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T19:50:00Z' });
    expect(engine.checkEligibility(c, Date.parse('2026-05-28T20:00:00Z')))
      .toEqual({ eligible: false, reason: 'not-silent-yet' });
  });

  it('rejects cap-reached', async () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T18:00:00Z' });
    await tracker.mutate(c.id, (prev) => ({ ...prev, redriveCount: 2 } as Commitment));
    const updated = tracker.get(c.id)!;
    expect(engine.checkEligibility(updated, Date.parse('2026-05-28T20:00:00Z')))
      .toEqual({ eligible: false, reason: 'cap-reached' });
  });

  it('rejects spacing-window (re-drive too recent)', async () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T18:00:00Z' });
    await tracker.mutate(c.id, (prev) => ({
      ...prev,
      redriveCount: 1,
      lastRedriveAt: '2026-05-28T19:50:00Z',
    } as Commitment));
    const updated = tracker.get(c.id)!;
    expect(engine.checkEligibility(updated, Date.parse('2026-05-28T20:00:00Z')))
      .toEqual({ eligible: false, reason: 'spacing-window' });
  });

  it('rejects no-related-agent', () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T18:00:00Z' });
    const bad = { ...c, relatedAgent: undefined } as Commitment;
    expect(engine.checkEligibility(bad, Date.parse('2026-05-28T20:00:00Z')))
      .toEqual({ eligible: false, reason: 'no-related-agent' });
  });

  it('ACCEPTS the positive case (silence past threshold + no cap + has peer)', () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T18:00:00Z' });
    expect(engine.checkEligibility(c, Date.parse('2026-05-28T20:00:00Z'))).toEqual({ eligible: true });
  });
});

describe('CollaborationRedriveEngine — reply-independent durable cap (the round-1 adversarial fix)', () => {
  let dir: string;
  let tracker: CommitmentTracker;
  let engine: CollaborationRedriveEngine;
  let relay: ReturnType<typeof makeRelayStub>;

  beforeEach(() => {
    dir = makeTmpDir();
    tracker = setupTracker(dir);
    relay = makeRelayStub();
    engine = new CollaborationRedriveEngine(
      {
        commitmentTracker: tracker,
        completionEvaluator: new CompletionEvaluator({ intelligence: makeStubIntelligence('NOT_MET') }),
        relayClient: relay.client as never,
        knownAgentsPath: makeKnownAgents(dir, [{ name: 'dawn', publicKey: 'fp-dawn-1' }]),
        now: () => Date.parse('2026-05-28T20:00:00Z'),
        log: { log: () => undefined, warn: () => undefined },
      },
      { ...DEFAULT_REDRIVE_CONFIG, enabled: true, maxRedrives: 2, maxRedrivesPerTick: 10 },
    );
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/CollaborationRedriveEngine.test.ts cleanup' });
  });

  it('a counterpart reply RESETS lastReplyAt but does NOT reset redriveCount (mutual-drive termination)', async () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T18:00:00Z' });

    let result = await engine.tick();
    expect(result.sent).toBe(1);
    let updated = tracker.get(c.id)!;
    expect(updated.redriveCount).toBe(1);

    const replyAt = '2026-05-28T20:01:00Z';
    tracker.markReplyArrived(c.id, replyAt);
    updated = tracker.get(c.id)!;
    expect(updated.lastReplyAt).toBe(replyAt);
    expect(updated.redriveCount).toBe(1);

    const laterEngine = new CollaborationRedriveEngine(
      {
        commitmentTracker: tracker,
        completionEvaluator: new CompletionEvaluator({ intelligence: makeStubIntelligence('NOT_MET') }),
        relayClient: relay.client as never,
        knownAgentsPath: makeKnownAgents(dir, [{ name: 'dawn', publicKey: 'fp-dawn-1' }]),
        now: () => Date.parse('2026-05-28T22:00:00Z'),
        log: { log: () => undefined, warn: () => undefined },
      },
      { ...DEFAULT_REDRIVE_CONFIG, enabled: true, maxRedrives: 2, maxRedrivesPerTick: 10 },
    );
    result = await laterEngine.tick();
    expect(result.sent).toBe(1);
    updated = tracker.get(c.id)!;
    expect(updated.redriveCount).toBe(2);

    tracker.markReplyArrived(c.id, '2026-05-28T22:01:00Z');
    const evenLaterEngine = new CollaborationRedriveEngine(
      {
        commitmentTracker: tracker,
        completionEvaluator: new CompletionEvaluator({ intelligence: makeStubIntelligence('NOT_MET') }),
        relayClient: relay.client as never,
        knownAgentsPath: makeKnownAgents(dir, [{ name: 'dawn', publicKey: 'fp-dawn-1' }]),
        now: () => Date.parse('2026-05-29T00:30:00Z'),
        log: { log: () => undefined, warn: () => undefined },
      },
      { ...DEFAULT_REDRIVE_CONFIG, enabled: true, maxRedrives: 2, maxRedrivesPerTick: 10 },
    );
    result = await evenLaterEngine.tick();
    expect(result.sent).toBe(0);
    expect(result.skipped[c.id]).toContain('cap-reached');
  });

  it('restart-survival: redriveCount persists on disk via mutate() and is read back', async () => {
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T18:00:00Z' });
    const result = await engine.tick();
    expect(result.sent).toBe(1);

    const tracker2 = setupTracker(dir);
    const reloaded = tracker2.get(c.id);
    expect(reloaded?.redriveCount).toBe(1);
    expect(reloaded?.lastRedriveAt).toBeTruthy();
  });
});

describe('CollaborationRedriveEngine — name → fingerprint resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/CollaborationRedriveEngine.test.ts cleanup' });
  });

  it('an unresolvable name SKIPS without sending and without incrementing the cap', async () => {
    const tracker = setupTracker(dir);
    const relay = makeRelayStub();
    const engine = new CollaborationRedriveEngine(
      {
        commitmentTracker: tracker,
        completionEvaluator: new CompletionEvaluator({ intelligence: makeStubIntelligence('NOT_MET') }),
        relayClient: relay.client as never,
        knownAgentsPath: makeKnownAgents(dir, [{ name: 'someone-else', publicKey: 'fp-other' }]),
        now: () => Date.parse('2026-05-28T20:00:00Z'),
        log: { log: () => undefined, warn: () => undefined },
      },
      { ...DEFAULT_REDRIVE_CONFIG, enabled: true },
    );
    const c = recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2026-05-28T18:00:00Z' });
    const result = await engine.tick();
    expect(result.sent).toBe(0);
    expect(result.skipped[c.id]).toContain('unresolved-name');
    expect(relay.sent.length).toBe(0);
    const updated = tracker.get(c.id)!;
    expect(updated.redriveCount ?? 0).toBe(0);
  });
});

describe('CollaborationRedriveEngine — disabled mode', () => {
  it('tick is a no-op when enabled:false (the ship-OFF default)', async () => {
    const dir = makeTmpDir();
    try {
      const tracker = setupTracker(dir);
      const engine = new CollaborationRedriveEngine(
        {
          commitmentTracker: tracker,
          completionEvaluator: new CompletionEvaluator({ intelligence: makeStubIntelligence() }),
          knownAgentsPath: makeKnownAgents(dir, []),
          log: { log: () => undefined, warn: () => undefined },
        },
        { ...DEFAULT_REDRIVE_CONFIG, enabled: false },
      );
      recordThreadlineReplyCommitment(tracker, { lastReplyAt: '2020-01-01T00:00:00Z' });
      const result = await engine.tick();
      expect(result.disabled).toBe(true);
      expect(result.sent).toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/CollaborationRedriveEngine.test.ts cleanup' });
    }
  });
});

describe('jaccard3gram', () => {
  it('returns 0 for non-overlapping phrases', () => {
    expect(jaccard3gram('one two three', 'four five six')).toBe(0);
  });
  it('returns 1 for identical phrases (when n-grams form)', () => {
    expect(jaccard3gram('one two three four', 'one two three four')).toBe(1);
  });
  it('returns 0 when texts are shorter than n', () => {
    expect(jaccard3gram('hi', 'hello')).toBe(0);
  });
});

describe('referenceMs', () => {
  it('uses lastReplyAt when present', () => {
    const c = { lastReplyAt: '2026-05-28T18:00:00Z', createdAt: '2026-05-28T10:00:00Z' } as Commitment;
    expect(referenceMs(c)).toBe(Date.parse('2026-05-28T18:00:00Z'));
  });
  it('falls back to createdAt when lastReplyAt missing', () => {
    const c = { createdAt: '2026-05-28T10:00:00Z' } as Commitment;
    expect(referenceMs(c)).toBe(Date.parse('2026-05-28T10:00:00Z'));
  });
  it('returns +Infinity for an unparseable reference (sorts last)', () => {
    const c = { lastReplyAt: 'not-a-date', createdAt: 'also-not' } as Commitment;
    expect(referenceMs(c)).toBe(Number.POSITIVE_INFINITY);
  });
});
