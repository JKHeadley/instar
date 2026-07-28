/**
 * Tier-1 tests for LiveTailBuffer (sequence-dedup, §8 G3b) + liveTailRedaction (§8 G3c).
 * Context integrity: no double-append, ordered application, bounded holdout,
 * gap-discard, byte cap. Plus redaction of credential-shaped material.
 */

import { describe, it, expect } from 'vitest';
import { LiveTailBuffer } from '../../src/core/LiveTailBuffer.js';
import { redactForLiveTail, RedactionCategory } from '../../src/core/liveTailRedaction.js';

const T = 'topic-1';
const flush = (seq: number, content: string) => ({ seq, topic: T, content });

describe('LiveTailBuffer — sequence dedup', () => {
  it('applies contiguous flushes in order', () => {
    const b = new LiveTailBuffer({ outOfOrderTimeoutMs: 60_000, maxBytesPerTopic: 1_000_000 });
    expect(b.applyFlush(flush(1, 'a')).reason).toBe('applied');
    expect(b.applyFlush(flush(2, 'b')).reason).toBe('applied');
    expect(b.getTail(T).content).toBe('ab');
    expect(b.getLastAppliedSeq(T)).toBe(2);
  });

  it('drops a duplicate flush (no double-append)', () => {
    const b = new LiveTailBuffer({ outOfOrderTimeoutMs: 60_000, maxBytesPerTopic: 1_000_000 });
    b.applyFlush(flush(1, 'a'));
    b.applyFlush(flush(2, 'b'));
    const dup = b.applyFlush(flush(2, 'b')); // at-least-once redelivery
    expect(dup.applied).toBe(false);
    expect(dup.reason).toBe('duplicate');
    expect(b.getTail(T).content).toBe('ab'); // not 'abb'
  });

  it('holds an out-of-order flush then drains when the gap fills', () => {
    const b = new LiveTailBuffer({ outOfOrderTimeoutMs: 60_000, maxBytesPerTopic: 1_000_000 });
    b.applyFlush(flush(1, 'a'));
    const held = b.applyFlush(flush(3, 'c')); // gap at 2
    expect(held.reason).toBe('held-out-of-order');
    expect(b.heldCount(T)).toBe(1);
    expect(b.getTail(T).content).toBe('a');
    // Fill the gap → 2 then drains 3.
    const fill = b.applyFlush(flush(2, 'b'));
    expect(fill.reason).toBe('applied');
    expect(b.getTail(T).content).toBe('abc');
    expect(b.heldCount(T)).toBe(0);
  });

  it('declares an unfillable gap after the timeout and proceeds', () => {
    let now = 1_000;
    const b = new LiveTailBuffer({ outOfOrderTimeoutMs: 5_000, maxBytesPerTopic: 1_000_000, now: () => now });
    b.applyFlush(flush(1, 'a'));
    b.applyFlush(flush(3, 'c')); // held, gap at 2
    now += 6_000; // gap times out
    const res = b.applyFlush(flush(5, 'e')); // a later flush arrives
    expect(res.reason).toBe('gap-discarded-then-applied');
    expect(b.getLastAppliedSeq(T)).toBe(5);
    expect(b.heldCount(T)).toBe(0); // held discarded
  });

  it('enforces the per-topic byte cap (drop-oldest)', () => {
    const b = new LiveTailBuffer({ outOfOrderTimeoutMs: 60_000, maxBytesPerTopic: 5 });
    b.applyFlush({ seq: 1, topic: T, content: 'aaa', bytes: 3 });
    b.applyFlush({ seq: 2, topic: T, content: 'bbb', bytes: 3 }); // total 6 > 5 → drop oldest
    const tail = b.getTail(T);
    expect(tail.content).toBe('bbb');
    expect(tail.lastAppliedSeq).toBe(2);
  });
});

describe('liveTailRedaction', () => {
  it('redacts a bearer token', () => {
    const r = redactForLiveTail('Authorization: Bearer abcdef1234567890XYZ');
    expect(r.text).not.toContain('abcdef1234567890XYZ');
    expect(r.categories).toContain(RedactionCategory.BearerToken);
    expect(r.redactedCount).toBeGreaterThan(0);
  });

  it('redacts a private key block', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nMIIB...secret...\n-----END OPENSSH PRIVATE KEY-----';
    const r = redactForLiveTail(`here is my key:\n${pem}`);
    expect(r.text).not.toContain('secret');
    expect(r.categories).toContain(RedactionCategory.PrivateKeyBlock);
  });

  it('redacts secret assignments and api keys', () => {
    const r = redactForLiveTail('api_key = "sk-ABCD1234EFGH5678IJKL" and token: ghp_abcdefghijklmnop1234');
    expect(r.text).not.toContain('sk-ABCD1234EFGH5678IJKL');
    expect(r.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it('leaves ordinary text untouched', () => {
    const r = redactForLiveTail('what were we discussing about the deploy?');
    expect(r.text).toBe('what were we discussing about the deploy?');
    expect(r.redactedCount).toBe(0);
  });
});
