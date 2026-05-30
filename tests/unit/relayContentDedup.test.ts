import { describe, it, expect } from 'vitest';
import { RelayContentDedup } from '../../src/messaging/relayContentDedup.js';

/**
 * Unit coverage for the relay-agent content-hash dedup (the duplicate-reply
 * fix). Both sides of every boundary: fresh→process, retry-within-window→drop,
 * window-expiry→process, distinguishing field changes, normalization, and the
 * memory cap.
 */
describe('RelayContentDedup', () => {
  const mkClock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  };

  it('processes a fresh (sender, thread, content) inbound', () => {
    const d = new RelayContentDedup({ now: () => 1000 });
    expect(d.shouldProcess('codey', 'thread-1', 'fix the bug')).toBe(true);
  });

  it('drops an identical retry within the window (the bug: fresh id, same content)', () => {
    const clock = mkClock();
    const d = new RelayContentDedup({ ttlMs: 60_000, now: clock.now });
    expect(d.shouldProcess('codey', 'thread-1', 'fix the bug')).toBe(true);
    clock.advance(5_000); // sender timed out + retried 5s later with a new id
    expect(d.shouldProcess('codey', 'thread-1', 'fix the bug')).toBe(false);
  });

  it('processes again once the window has elapsed (plausibly a real re-send)', () => {
    const clock = mkClock();
    const d = new RelayContentDedup({ ttlMs: 60_000, now: clock.now });
    expect(d.shouldProcess('codey', 'thread-1', 'ping')).toBe(true);
    clock.advance(60_001);
    expect(d.shouldProcess('codey', 'thread-1', 'ping')).toBe(true);
  });

  it('does NOT collapse genuinely different messages (content differs)', () => {
    const d = new RelayContentDedup({ now: () => 1000 });
    expect(d.shouldProcess('codey', 'thread-1', 'message A')).toBe(true);
    expect(d.shouldProcess('codey', 'thread-1', 'message B')).toBe(true);
  });

  it('distinguishes by sender and by thread', () => {
    const d = new RelayContentDedup({ now: () => 1000 });
    expect(d.shouldProcess('codey', 'thread-1', 'same text')).toBe(true);
    expect(d.shouldProcess('aiguy', 'thread-1', 'same text')).toBe(true); // different sender
    expect(d.shouldProcess('codey', 'thread-2', 'same text')).toBe(true); // different thread
    // and the original is still deduped
    expect(d.shouldProcess('codey', 'thread-1', 'same text')).toBe(false);
  });

  it('normalizes insignificant whitespace so a whitespace-only retry is deduped', () => {
    const clock = mkClock();
    const d = new RelayContentDedup({ ttlMs: 60_000, now: clock.now });
    expect(d.shouldProcess('codey', 'thread-1', 'hello world')).toBe(true);
    clock.advance(1_000);
    expect(d.shouldProcess('codey', 'thread-1', '  hello   world  ')).toBe(false);
  });

  it('keyFor is deterministic and field-sensitive', () => {
    const k1 = RelayContentDedup.keyFor('codey', 't1', 'x');
    const k2 = RelayContentDedup.keyFor('codey', 't1', 'x');
    const k3 = RelayContentDedup.keyFor('codey', 't1', 'y');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bounds memory via maxEntries (oldest evicted)', () => {
    const clock = mkClock();
    const d = new RelayContentDedup({ ttlMs: 10_000_000, maxEntries: 3, now: clock.now });
    for (let i = 0; i < 10; i++) {
      clock.advance(1);
      d.shouldProcess('codey', 'thread-1', `msg-${i}`);
    }
    expect(d.size()).toBeLessThanOrEqual(3);
    // The oldest (msg-0) was evicted → treated as fresh again, not deduped.
    expect(d.shouldProcess('codey', 'thread-1', 'msg-0')).toBe(true);
    // The most-recent (msg-9) is still within the retained window → deduped.
    expect(d.shouldProcess('codey', 'thread-1', 'msg-9')).toBe(false);
  });

  it('lazily sweeps expired keys so size does not grow unbounded over time', () => {
    const clock = mkClock();
    const d = new RelayContentDedup({ ttlMs: 1_000, now: clock.now });
    d.shouldProcess('codey', 'thread-1', 'a');
    d.shouldProcess('codey', 'thread-1', 'b');
    expect(d.size()).toBe(2);
    clock.advance(2_000); // both expire
    d.shouldProcess('codey', 'thread-1', 'c'); // triggers sweep
    expect(d.size()).toBe(1);
  });
});
