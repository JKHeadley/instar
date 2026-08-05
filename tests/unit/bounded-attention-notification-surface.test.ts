/**
 * Bounded Attention-Notification Surface — unit tests.
 * Spec: docs/specs/bounded-attention-notification-surface.md
 *
 * EVERY assertion is paired with a CONTROL that must fail. A check that cannot
 * fail is not a check — the control is what proves the assertion is measuring
 * the guard rather than something incidentally true.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NotificationBatcher,
  type OwnershipVerdict,
} from '../../src/messaging/NotificationBatcher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * A payload that is genuinely distinct AFTER dedup normalization.
 * `generateDedupKey` replaces every digit run with `_`, so "notice 1" and
 * "notice 2" collapse to the SAME key. Distinctness must therefore come from
 * letters. Getting this wrong made two earlier controls pass for the wrong
 * reason — the payloads were identical to the deduper and it was doing its job.
 */
function distinctPayload(i: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let n = i, word = '';
  do { word = alphabet[n % 26] + word; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `notice ${word} ${word}${word} distinct`;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nb-bound-'));
}

interface Harness {
  batcher: NotificationBatcher;
  sent: Array<{ topicId: number; text: string }>;
}

function makeBatcher(opts: {
  stateDir?: string | null;
  ownership?: OwnershipVerdict | (() => OwnershipVerdict);
  config?: Record<string, unknown>;
} = {}): Harness {
  const sent: Array<{ topicId: number; text: string }> = [];
  const batcher = new NotificationBatcher({
    enabled: true,
    summaryIntervalMinutes: 30,
    digestIntervalMinutes: 120,
    maxMessagesPerTopicPerHour: 4,
    suppressionTtlHours: 24,
    maxHoldHours: 6,
    maxHeldItemsPerTopic: 200,
    ...(opts.config ?? {}),
  });
  batcher.setSendFunction(async (topicId, text) => {
    sent.push({ topicId, text });
    return { messageId: sent.length };
  });
  if (opts.stateDir !== undefined || opts.ownership !== undefined) {
    batcher.configureBounds({
      stateDir: opts.stateDir ?? null,
      ownershipResolver:
        opts.ownership === undefined
          ? null
          : typeof opts.ownership === 'function'
            ? opts.ownership
            : () => opts.ownership as OwnershipVerdict,
    });
  }
  return { batcher, sent };
}

const note = (topicId: number, message: string, tier: 'SUMMARY' | 'DIGEST' | 'IMMEDIATE' = 'SUMMARY') => ({
  tier,
  category: 'system',
  message,
  timestamp: new Date(),
  topicId,
});

describe('C2 — enqueue honours the `enabled` flag', () => {
  it('drops SUMMARY/DIGEST when disabled, and still sends IMMEDIATE', async () => {
    const { batcher, sent } = makeBatcher({ config: { enabled: false } });

    await batcher.enqueue(note(1, 'batched housekeeping'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(0);
    expect(batcher.getStats().totalSuppressed).toBe(1);

    // IMMEDIATE must survive the kill-switch — a switch on batching must never
    // become a switch on urgency.
    await batcher.enqueue(note(1, 'urgent', 'IMMEDIATE'));
    expect(sent).toHaveLength(1);
  });

  it('CONTROL: with enabled=true the same SUMMARY sends', async () => {
    const { batcher, sent } = makeBatcher({ config: { enabled: true } });
    await batcher.enqueue(note(1, 'batched housekeeping'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1);
  });
});

describe('C4.2 — rolling-window limit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds past the limit, retains the items, and sends nothing extra', async () => {
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 2 } });

    for (const m of ['a', 'b', 'c']) {
      await batcher.enqueue(note(7, m));
      await batcher.flush('SUMMARY');
    }

    expect(sent).toHaveLength(2);
    const stats = batcher.getStats();
    expect(stats.heldCount).toBeGreaterThan(0);
    expect(stats.summaryQueueSize).toBeGreaterThan(0); // retained, not dropped
  });

  it('CONTROL: IMMEDIATE still sends inside a saturated window', async () => {
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 1 } });
    await batcher.enqueue(note(7, 'a'));
    await batcher.flush('SUMMARY');
    await batcher.enqueue(note(7, 'b'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1); // window saturated

    await batcher.enqueue(note(7, 'urgent', 'IMMEDIATE'));
    // Proves the hold is the LIMIT, not a dead sender.
    expect(sent).toHaveLength(2);
  });

  it('the window is ROLLING: an entry expiring frees a slot', async () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 1 } });

    await batcher.enqueue(note(9, 'first'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1);

    // 50 minutes later: still inside the window → held.
    vi.setSystemTime(new Date('2026-08-04T00:50:00Z'));
    await batcher.enqueue(note(9, 'second'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1);

    // 61 minutes: the first send has aged out → sends.
    vi.setSystemTime(new Date('2026-08-04T01:01:00Z'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(2);
  });

  it('CONTROL: without advancing the clock the item stays held', async () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 1 } });
    await batcher.enqueue(note(9, 'first'));
    await batcher.flush('SUMMARY');
    await batcher.enqueue(note(9, 'second'));
    await batcher.flush('SUMMARY');
    await batcher.flush('SUMMARY'); // repeated attempts, clock frozen
    expect(sent).toHaveLength(1);
  });

  it('limit 0 DISABLES the limiter rather than holding everything', async () => {
    // Without the explicit guard, `length >= 0` is always true and 0 would hold
    // every message forever — the opposite of the documented meaning.
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 0 } });
    for (const m of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await batcher.enqueue(note(3, m));
      await batcher.flush('SUMMARY');
    }
    expect(sent).toHaveLength(6);
  });

  it('CONTROL: limit 1 on the same sequence holds after the first', async () => {
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 1 } });
    for (const m of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await batcher.enqueue(note(3, m));
      await batcher.flush('SUMMARY');
    }
    expect(sent).toHaveLength(1);
  });
});

describe('C4.1 — only the owning machine sends', () => {
  it('an owner sends; a non-owner records notOwnerSkipped and sends nothing', async () => {
    const owner = makeBatcher({ ownership: 'owner', stateDir: null });
    await owner.batcher.enqueue(note(11, 'x'));
    await owner.batcher.flush('SUMMARY');
    expect(owner.sent).toHaveLength(1);

    const other = makeBatcher({ ownership: 'other', stateDir: null });
    await other.batcher.enqueue(note(11, 'x'));
    await other.batcher.flush('SUMMARY');
    expect(other.sent).toHaveLength(0);
    expect(other.batcher.getStats().notOwnerSkipped).toBeGreaterThan(0);
  });

  it('CONTROL: the roles invert with the verdict — the test reads ownership, not a fixed identity', async () => {
    const a = makeBatcher({ ownership: 'other', stateDir: null });
    await a.batcher.enqueue(note(12, 'y'));
    await a.batcher.flush('SUMMARY');
    expect(a.sent).toHaveLength(0);

    const b = makeBatcher({ ownership: 'owner', stateDir: null });
    await b.batcher.enqueue(note(12, 'y'));
    await b.batcher.flush('SUMMARY');
    expect(b.sent).toHaveLength(1);
  });

  it('unresolvable ownership HOLDS when a pool exists and SENDS when none does', async () => {
    const pooled = makeBatcher({ ownership: 'unresolvable-pool', stateDir: null });
    await pooled.batcher.enqueue(note(13, 'z'));
    await pooled.batcher.flush('SUMMARY');
    expect(pooled.sent).toHaveLength(0);

    const solo = makeBatcher({ ownership: 'unresolvable-no-pool', stateDir: null });
    await solo.batcher.enqueue(note(13, 'z'));
    await solo.batcher.flush('SUMMARY');
    expect(solo.sent).toHaveLength(1);

    // CONTROL is built in: the two configurations MUST differ. A test that
    // passed under both would be measuring nothing.
    expect(pooled.sent.length).not.toBe(solo.sent.length);
  });

  it('a throwing resolver is treated as unresolvable-pool (hold), never as ownership', async () => {
    const { batcher, sent } = makeBatcher({
      ownership: () => {
        throw new Error('placement unreadable');
      },
      stateDir: null,
    });
    await batcher.enqueue(note(14, 'q'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(0);
  });
});

describe('C3 — persistence across restarts', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/bounded-attention-notification-surface.test.ts' }); });

  it('suppresses a repeat after a restart against the same stateDir', async () => {
    const first = makeBatcher({ stateDir: dir });
    await first.batcher.enqueue(note(21, 'identical notice'));
    await first.batcher.flush('SUMMARY');
    expect(first.sent).toHaveLength(1);

    const second = makeBatcher({ stateDir: dir });
    await second.batcher.enqueue(note(21, 'identical notice'));
    await second.batcher.flush('SUMMARY');
    expect(second.sent).toHaveLength(0);
  });

  it('CONTROL: a DIFFERENT stateDir sends it — the assertion is about persistence, not the key', async () => {
    const first = makeBatcher({ stateDir: dir });
    await first.batcher.enqueue(note(21, 'identical notice'));
    await first.batcher.flush('SUMMARY');

    const otherDir = tmpDir();
    try {
      const second = makeBatcher({ stateDir: otherDir });
      await second.batcher.enqueue(note(21, 'identical notice'));
      await second.batcher.flush('SUMMARY');
      expect(second.sent).toHaveLength(1);
    } finally {
      SafeFsExecutor.safeRmSync(otherDir, { recursive: true, force: true, operation: 'tests/unit/bounded-attention-notification-surface.test.ts' });
    }
  });

  it('a restart cannot mint rate-limit capacity', async () => {
    const first = makeBatcher({ stateDir: dir, config: { maxMessagesPerTopicPerHour: 1 } });
    await first.batcher.enqueue(note(22, 'one'));
    await first.batcher.flush('SUMMARY');
    expect(first.sent).toHaveLength(1);

    // Fresh instance, same stateDir, DIFFERENT message (so suppression is not
    // what holds it) — the window must still be saturated.
    const second = makeBatcher({ stateDir: dir, config: { maxMessagesPerTopicPerHour: 1 } });
    await second.batcher.enqueue(note(22, 'a completely different notice'));
    await second.batcher.flush('SUMMARY');
    expect(second.sent).toHaveLength(0);
  });

  it('CONTROL: the same fresh instance with limit 5 sends — proving the hold was the persisted window', async () => {
    const first = makeBatcher({ stateDir: dir, config: { maxMessagesPerTopicPerHour: 1 } });
    await first.batcher.enqueue(note(22, 'one'));
    await first.batcher.flush('SUMMARY');

    const second = makeBatcher({ stateDir: dir, config: { maxMessagesPerTopicPerHour: 5 } });
    await second.batcher.enqueue(note(22, 'a completely different notice'));
    await second.batcher.flush('SUMMARY');
    expect(second.sent).toHaveLength(1);
  });

  it('corrupt state fails CLOSED for the rate limiter and OPEN for suppression', async () => {
    fs.writeFileSync(path.join(dir, 'notification-suppression.json'), '{ this is not json', 'utf8');
    const { batcher, sent } = makeBatcher({ stateDir: dir });

    expect(batcher.getStats().rateStateReadable).toBe(false);

    // Rate state unreadable ⇒ the batched lane holds (losing sendTimes would
    // mint fresh capacity).
    await batcher.enqueue(note(23, 'anything'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(0);

    // Suppression failed OPEN in the same load — the map is empty, not poisoned.
    // IMMEDIATE is unaffected in both directions.
    await batcher.enqueue(note(23, 'urgent', 'IMMEDIATE'));
    expect(sent).toHaveLength(1);
  });

  it('CONTROL: a VALID state file on the same path does not hold', async () => {
    fs.writeFileSync(
      path.join(dir, 'notification-suppression.json'),
      JSON.stringify({ suppression: {}, sendTimes: {}, breaker: {} }),
      'utf8',
    );
    const { batcher, sent } = makeBatcher({ stateDir: dir });
    expect(batcher.getStats().rateStateReadable).toBe(true);
    await batcher.enqueue(note(23, 'anything'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1);
  });
});

describe('C4.4 — storage ceiling on the held queue', () => {
  it('bounds a stream of DISTINCT notices by folding the oldest into a counted aggregate', async () => {
    const { batcher } = makeBatcher({
      ownership: 'unresolvable-pool', // hold everything so nothing drains
      stateDir: null,
      config: { maxHeldItemsPerTopic: 10 },
    });

    for (let i = 0; i < 500; i++) {
      await batcher.enqueue(note(31, distinctPayload(i)));
    }

    const stats = batcher.getStats();
    expect(stats.summaryQueueSize).toBeLessThanOrEqual(11); // ceiling + the aggregate
    expect(stats.foldedItems).toBeGreaterThan(0);
  });

  it('CONTROL: 500 IDENTICAL notices collapse via the pre-existing dedup path, not the ceiling', async () => {
    const { batcher } = makeBatcher({
      ownership: 'unresolvable-pool',
      stateDir: null,
      config: { maxHeldItemsPerTopic: 10 },
    });

    for (let i = 0; i < 500; i++) {
      await batcher.enqueue(note(32, 'exactly the same notice every time'));
    }

    const stats = batcher.getStats();
    expect(stats.summaryQueueSize).toBe(1);
    // Nothing folded — this distinguishes the storage ceiling from dedup.
    expect(stats.foldedItems).toBe(0);
  });
});

describe('I3 — IMMEDIATE never enters the batched machine', () => {
  it('is unaffected by disabled, saturated window, foreign ownership, and corrupt state together', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'notification-suppression.json'), 'corrupt', 'utf8');
      const { batcher, sent } = makeBatcher({
        stateDir: dir,
        ownership: 'other',
        config: { enabled: false, maxMessagesPerTopicPerHour: 1 },
      });

      // Every batched gate is hostile at once.
      await batcher.enqueue(note(41, 'batched'));
      await batcher.flush('SUMMARY');
      expect(sent).toHaveLength(0);

      await batcher.enqueue(note(41, 'urgent one', 'IMMEDIATE'));
      await batcher.enqueue(note(41, 'urgent two', 'IMMEDIATE'));
      await batcher.enqueue(note(41, 'urgent three', 'IMMEDIATE'));
      expect(sent).toHaveLength(3);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/bounded-attention-notification-surface.test.ts' });
    }
  });
});

describe('Phase 5 second-pass findings — a failed send is not a delivery', () => {
  it('a failing sink dequeues nothing, suppresses nothing, and consumes no rate slot', async () => {
    const batcher = new NotificationBatcher({
      enabled: true, summaryIntervalMinutes: 30, digestIntervalMinutes: 120,
      maxMessagesPerTopicPerHour: 1, suppressionTtlHours: 24, maxHoldHours: 6, maxHeldItemsPerTopic: 200,
    });
    let failing = true;
    const delivered: string[] = [];
    batcher.setSendFunction(async (_t, text) => {
      if (failing) throw new Error('telegram down');
      delivered.push(text);
      return { messageId: delivered.length };
    });

    await batcher.enqueue(note(61, 'important-ish notice'));
    await batcher.flush('SUMMARY');
    expect(delivered).toHaveLength(0);
    // Still queued — a failed send must not silently drop the item.
    expect(batcher.getStats().summaryQueueSize).toBe(1);

    // The sink recovers. The item must STILL be deliverable: neither suppressed
    // (24h) nor rate-limited by a slot the failed attempt never earned.
    failing = false;
    await batcher.flush('SUMMARY');
    expect(delivered).toHaveLength(1);
  });

  it('CONTROL: a SUCCEEDING send does dequeue, suppress, and consume the slot', async () => {
    const batcher = new NotificationBatcher({
      enabled: true, summaryIntervalMinutes: 30, digestIntervalMinutes: 120,
      maxMessagesPerTopicPerHour: 1, suppressionTtlHours: 24, maxHoldHours: 6, maxHeldItemsPerTopic: 200,
    });
    const delivered: string[] = [];
    batcher.setSendFunction(async (_t, text) => { delivered.push(text); return { messageId: 1 }; });

    await batcher.enqueue(note(62, 'important-ish notice'));
    await batcher.flush('SUMMARY');
    expect(delivered).toHaveLength(1);
    expect(batcher.getStats().summaryQueueSize).toBe(0);

    // Slot consumed: a different notice now holds.
    await batcher.enqueue(note(62, 'a different notice entirely'));
    await batcher.flush('SUMMARY');
    expect(delivered).toHaveLength(1);
  });
});

describe('Phase 5 second-pass findings — maxHoldHours EXPIRES, it never collapses to a send', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a persistent-reason hold (foreign ownership) drops its backlog with a record, never sends', async () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const { batcher, sent } = makeBatcher({ ownership: 'other', stateDir: null });

    await batcher.enqueue(note(71, 'owned elsewhere'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(0);

    // Age far past maxHoldHours. An earlier design "collapsed" this into one
    // digest and sent it — from a machine that does not own the topic.
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    await batcher.flush('SUMMARY');

    expect(sent).toHaveLength(0);
    const stats = batcher.getStats();
    expect(stats.notOwnerExpired).toBeGreaterThan(0);
    expect(stats.summaryQueueSize).toBe(0); // terminal state — not an unbounded queue
  });

  it('CONTROL: a rate-limit hold on an OWNED topic drains normally when its window clears', async () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const { batcher, sent } = makeBatcher({
      ownership: 'owner', stateDir: null, config: { maxMessagesPerTopicPerHour: 1 },
    });

    await batcher.enqueue(note(72, 'first'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1);

    await batcher.enqueue(note(72, 'second'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1); // held by the window

    // The window clears long before maxHoldHours — which is exactly WHY the old
    // collapse path was unreachable for rate-limit holds. This control is what
    // exposed that: it distinguishes "drained because the window cleared" from
    // "expired because the reason persisted".
    vi.setSystemTime(new Date('2026-08-04T01:30:00Z'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(2);
    expect(batcher.getStats().notOwnerExpired).toBe(0);
  });
});

describe('Phase 5 second-pass findings — corrupt rate state never ages into a send', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a rate-state-unreadable hold expires rather than collapsing to a send', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'notification-suppression.json'), 'not json at all', 'utf8');
      vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
      const { batcher, sent } = makeBatcher({ stateDir: dir });
      expect(batcher.getStats().rateStateReadable).toBe(false);

      await batcher.enqueue(note(81, 'held by corrupt state'));
      await batcher.flush('SUMMARY');
      expect(sent).toHaveLength(0);

      // Age well past maxHoldHours. Collapsing here would mint exactly the
      // capacity the fail-closed rule exists to withhold.
      vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
      await batcher.flush('SUMMARY');
      expect(sent).toHaveLength(0);
      expect(batcher.getStats().heldExpired).toBeGreaterThan(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/bounded-attention-notification-surface.test.ts' });
    }
  });

  it('CONTROL: a plain rate-limit hold DOES collapse to one digest after maxHoldHours', async () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 1 } });

    await batcher.enqueue(note(82, 'first'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1);

    await batcher.enqueue(note(82, 'second'));
    await batcher.flush('SUMMARY');
    expect(sent).toHaveLength(1); // held

    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    await batcher.flush('SUMMARY');
    // Distinguishes "this hold reason expires" from "every hold expires".
    expect(sent).toHaveLength(2);
  });
});

describe('burst invariant — the bound holds under a 100-event burst', () => {
  it('a 100-event burst into one topic sends at most the limit', async () => {
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 4 } });

    for (let i = 0; i < 100; i++) {
      await batcher.enqueue(note(51, distinctPayload(i)));
      await batcher.flush('SUMMARY');
    }

    expect(sent.length).toBeLessThanOrEqual(4);
    expect(sent.length).toBeGreaterThan(0); // a zero-everywhere reading would be a DEAD test, not a pass
  });

  it('CONTROL: the same burst with the limiter disabled is NOT bounded', async () => {
    const { batcher, sent } = makeBatcher({ config: { maxMessagesPerTopicPerHour: 0 } });
    for (let i = 0; i < 100; i++) {
      await batcher.enqueue(note(52, distinctPayload(i)));
      await batcher.flush('SUMMARY');
    }
    // Proves the bound above is the limiter, not an artefact of the harness.
    expect(sent.length).toBeGreaterThan(4);
  });
});
