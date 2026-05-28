/**
 * Unit tests for ingressDedup — the exactly-once ingress decision (spec §8 G3a).
 * Both sides of every boundary, against a REAL in-memory MessageProcessingLedger
 * (no mocks — the ledger's SQLite logic is part of what's under test).
 */

import { describe, it, expect } from 'vitest';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { decideIngress, commitInboundReply, dedupeKeyFor } from '../../src/messaging/ingressDedup.js';

const KEY = 'telegram:13481:5000';

function freshLedger() {
  return MessageProcessingLedger.openMemory();
}

describe('dedupeKeyFor', () => {
  it('is stable + provider-scoped', () => {
    expect(dedupeKeyFor('telegram', 13481, 5000)).toBe('telegram:13481:5000');
    expect(dedupeKeyFor('telegram', 13481, 5000)).toBe(dedupeKeyFor('telegram', 13481, 5000));
    expect(dedupeKeyFor('telegram', 13481, 5001)).not.toBe(KEY);
  });
});

describe('decideIngress', () => {
  const base = { platform: 'telegram', topic: '13481', epoch: 1, maxProcessingMs: 300_000 };

  it('PROCESSES a first-seen event and claims it (processing)', () => {
    const led = freshLedger();
    const d = decideIngress(led, KEY, { ...base, input: 'hello' });
    expect(d.action).toBe('process');
    expect(d.reason).toBe('first-seen');
    expect(led.get(KEY)!.state).toBe('processing');
    expect(led.get(KEY)!.inputSnapshot).toBe('hello'); // stored for replay
  });

  it('DROPS a rapid redelivery while still in flight (processing, not stuck)', () => {
    const led = freshLedger();
    decideIngress(led, KEY, base); // first → processing
    const d2 = decideIngress(led, KEY, base); // redelivery moments later
    expect(d2.action).toBe('drop');
    expect(d2.reason).toBe('in-flight');
  });

  it('DROPS a redelivery after the reply was committed', () => {
    const led = freshLedger();
    decideIngress(led, KEY, base);
    commitInboundReply(led, KEY, 1);
    const d = decideIngress(led, KEY, base);
    expect(d.action).toBe('drop');
    expect(d.reason).toBe('already-replied');
  });

  it('RE-CLAIMS a processing entry stuck past maxProcessingMs (fenced holder)', () => {
    // The ledger stamps processingStartedAt with real wall-clock time, so model
    // "stuck" with a maxProcessingMs the real elapsed time already exceeds.
    const led = freshLedger();
    decideIngress(led, KEY, { ...base, maxProcessingMs: -1 }); // processing now
    const d = decideIngress(led, KEY, { ...base, maxProcessingMs: -1 }); // any elapsed > -1 → stuck
    expect(d.action).toBe('process');
    expect(d.reason).toBe('reclaimed-stuck');
    expect(led.get(KEY)!.attempts).toBe(2); // re-claimed
  });

  it('does NOT re-claim a processing entry still within maxProcessingMs', () => {
    const led = freshLedger();
    decideIngress(led, KEY, base); // maxProcessingMs = 300_000
    const d = decideIngress(led, KEY, base); // well within the window
    expect(d.action).toBe('drop');
    expect(d.reason).toBe('in-flight');
  });
});

describe('commitInboundReply', () => {
  it('marks reply_committed + cursor_advanced; second commit is a no-op', () => {
    const led = freshLedger();
    decideIngress(led, KEY, { platform: 'telegram', topic: '13481', epoch: 2, maxProcessingMs: 300_000 });
    commitInboundReply(led, KEY, 2);
    const e = led.get(KEY)!;
    expect(e.state).toBe('cursor_advanced');
    expect(e.replyIdempotencyKey).toBeTruthy();
    expect(e.replyEpoch).toBe(2);
    // Idempotent — committing again does not throw or regress state.
    commitInboundReply(led, KEY, 2);
    expect(led.get(KEY)!.state).toBe('cursor_advanced');
  });

  it('produces a deterministic idempotency key for the same dedupeKey+index', () => {
    const a = freshLedger();
    const b = freshLedger();
    decideIngress(a, KEY, { platform: 'telegram', topic: '13481', epoch: 1, maxProcessingMs: 300_000 });
    decideIngress(b, KEY, { platform: 'telegram', topic: '13481', epoch: 9, maxProcessingMs: 300_000 });
    commitInboundReply(a, KEY, 1);
    commitInboundReply(b, KEY, 9);
    // Same dedupeKey + replyIndex → same idempotency key on any machine.
    expect(a.get(KEY)!.replyIdempotencyKey).toBe(b.get(KEY)!.replyIdempotencyKey);
  });
});
