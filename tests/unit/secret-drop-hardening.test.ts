/**
 * Verifies the Secret Drop hardening added after the 2026-05-20
 * topic-10873 incident. A buggy bridge consumer called the (then
 * destructive) `/secrets/retrieve/<token>` endpoint, failed to extract
 * the value, and silently lost the SMS code. The hardening makes
 * retrieval non-destructive by default, adds an explicit consume path,
 * and emits a stuck-consumer event when a submission lingers
 * unconsumed past the grace window.
 *
 * The tests below pin each part of that contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SecretDrop, type StuckConsumerEvent } from '../../src/server/SecretDrop.js';

function submitOne(drop: SecretDrop, label = 'Test Secret') {
  const { token } = drop.create({
    label,
    fields: [{ name: 'code', label: 'Code' }],
    topicId: 10873,
  });
  const pending = drop.getPending(token);
  if (!pending) throw new Error('pending missing — test setup wrong');
  const submission = drop.submit(token, pending.csrfToken, { code: '12345' });
  if (!submission) throw new Error('submit returned null — test setup wrong');
  return { token, submission };
}

describe('SecretDrop — non-destructive default retrieval', () => {
  let drop: SecretDrop;

  beforeEach(() => {
    drop = new SecretDrop('test-agent');
  });

  afterEach(() => {
    drop.shutdown();
  });

  it('peekReceived returns the submission without removing it', () => {
    const { token } = submitOne(drop);
    const first = drop.peekReceived(token);
    expect(first).not.toBeNull();
    expect(first!.values.code).toBe('12345');
    // Calling again must return the same submission, not null.
    const second = drop.peekReceived(token);
    expect(second).not.toBeNull();
    expect(second!.values.code).toBe('12345');
  });

  it('peekReceived returns null for an unknown token', () => {
    expect(drop.peekReceived('does-not-exist')).toBeNull();
  });

  it('consumeReceived returns the submission and removes it on first call', () => {
    const { token } = submitOne(drop);
    const first = drop.consumeReceived(token);
    expect(first).not.toBeNull();
    expect(first!.values.code).toBe('12345');
    // Now it's gone.
    expect(drop.consumeReceived(token)).toBeNull();
    expect(drop.peekReceived(token)).toBeNull();
  });

  it('peek then consume: peek leaves the submission, consume removes it', () => {
    const { token } = submitOne(drop);
    expect(drop.peekReceived(token)).not.toBeNull();
    expect(drop.peekReceived(token)).not.toBeNull();
    const consumed = drop.consumeReceived(token);
    expect(consumed).not.toBeNull();
    // After consume, peek returns null.
    expect(drop.peekReceived(token)).toBeNull();
  });

  it('legacy getReceived behaves like consumeReceived (back-compat)', () => {
    const { token } = submitOne(drop);
    const first = drop.getReceived(token);
    expect(first).not.toBeNull();
    // Legacy semantics: deleted on first read.
    expect(drop.getReceived(token)).toBeNull();
    expect(drop.peekReceived(token)).toBeNull();
  });
});

describe('SecretDrop — regression: 2026-05-20 lost-SMS-code scenario', () => {
  let drop: SecretDrop;

  beforeEach(() => {
    drop = new SecretDrop('echo');
  });

  afterEach(() => {
    drop.shutdown();
  });

  it('a buggy consumer can retry after dropping the value on first call', () => {
    // Submit a code, then simulate the original failure: the bridge
    // consumer "reads" the value via the non-destructive endpoint, then
    // its parser fails and it drops the value. Under the old code, the
    // submission would now be gone. Under the new code, it can retry.
    const { token } = submitOne(drop, 'Telegram MTProto SMS code');

    // First read: buggy parser drops it.
    const firstRead = drop.peekReceived(token);
    expect(firstRead).not.toBeNull();
    // Bug: parser fails, value is dropped on the caller side.

    // Second read: retry succeeds because the submission is still there.
    const secondRead = drop.peekReceived(token);
    expect(secondRead).not.toBeNull();
    expect(secondRead!.values.code).toBe('12345');

    // Caller eventually fixes the parse and consumes explicitly.
    const consumed = drop.consumeReceived(token);
    expect(consumed).not.toBeNull();
    expect(consumed!.values.code).toBe('12345');
  });
});

describe('SecretDrop — stuck-consumer event', () => {
  let drop: SecretDrop;

  beforeEach(() => {
    vi.useFakeTimers();
    drop = new SecretDrop('test-agent');
  });

  afterEach(() => {
    drop.shutdown();
    vi.useRealTimers();
  });

  it('fires after the 60s grace period when nobody consumes', () => {
    const events: StuckConsumerEvent[] = [];
    drop.onStuckConsumer((e) => events.push(e));
    const { token } = submitOne(drop, 'Stuck Test');

    // No consume — advance past the 60s grace period.
    vi.advanceTimersByTime(60_000 + 100);

    expect(events).toHaveLength(1);
    expect(events[0].token).toBe(token);
    expect(events[0].label).toBe('Stuck Test');
    expect(events[0].topicId).toBe(10873);
    expect(events[0].minutesUntilCleanup).toBeGreaterThanOrEqual(3);
  });

  it('does NOT fire when the submission was explicitly consumed before the grace ends', () => {
    const events: StuckConsumerEvent[] = [];
    drop.onStuckConsumer((e) => events.push(e));
    const { token } = submitOne(drop);

    // Consumer claims the value at 30s — well before the grace expires.
    vi.advanceTimersByTime(30_000);
    drop.consumeReceived(token);

    // Now advance past the grace boundary.
    vi.advanceTimersByTime(60_000);

    expect(events).toHaveLength(0);
  });

  it('fires once at 60s, even when the cleanup timer runs later', () => {
    // The 60s stuck timer fires first; the idle cleanup timer (15-minute
    // sliding window) fires later. The listener should see exactly one event,
    // not two. No intermediate peek here, so the window does not slide and the
    // submission is purged at the idle deadline.
    const events: StuckConsumerEvent[] = [];
    drop.onStuckConsumer((e) => events.push(e));
    const { token } = submitOne(drop);

    vi.advanceTimersByTime(15 * 60_000 + 100);

    expect(drop.peekReceived(token)).toBeNull();
    expect(events).toHaveLength(1);
  });

  it('invokes every registered listener; one bad listener does not block others', () => {
    const seenA: StuckConsumerEvent[] = [];
    const seenB: StuckConsumerEvent[] = [];
    drop.onStuckConsumer(() => {
      throw new Error('boom from listener A');
    });
    drop.onStuckConsumer((e) => seenA.push(e));
    drop.onStuckConsumer((e) => seenB.push(e));

    submitOne(drop);
    vi.advanceTimersByTime(60_000 + 100);

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
  });
});

describe('SecretDrop — auto-cleanup timer interactions', () => {
  let drop: SecretDrop;

  beforeEach(() => {
    vi.useFakeTimers();
    drop = new SecretDrop('test-agent');
  });

  afterEach(() => {
    drop.shutdown();
    vi.useRealTimers();
  });

  it('submission disappears after the idle window (15 min) even if never consumed', () => {
    const { token } = submitOne(drop);
    expect(drop.peekReceived(token)).not.toBeNull();
    // Idle window is now 15 min (was a fixed 5 min). The peek above slides it,
    // but with no further activity it is purged one idle window later.
    vi.advanceTimersByTime(15 * 60_000 + 100);
    expect(drop.peekReceived(token)).toBeNull();
  });

  it('cleanup timer does not double-fire if consume happened first', () => {
    const { token } = submitOne(drop);
    drop.consumeReceived(token);
    // Advance past cleanup — nothing should throw (consume already removed it).
    vi.advanceTimersByTime(15 * 60_000 + 100);
    expect(drop.peekReceived(token)).toBeNull();
  });
});

describe('SecretDrop — submit still consumes the pending request (unchanged)', () => {
  let drop: SecretDrop;

  beforeEach(() => {
    drop = new SecretDrop('test-agent');
  });
  afterEach(() => {
    drop.shutdown();
  });

  it('a second submit attempt for the same token returns null', () => {
    const { token } = drop.create({
      label: 'one-time',
      fields: [{ name: 'code', label: 'Code' }],
      topicId: 10873,
    });
    const pending = drop.getPending(token)!;
    const first = drop.submit(token, pending.csrfToken, { code: 'A' });
    expect(first).not.toBeNull();
    const second = drop.submit(token, pending.csrfToken, { code: 'B' });
    expect(second).toBeNull();
  });
});
