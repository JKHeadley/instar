// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Wiring-integrity tests for A2A redelivery (A2A-DURABLE-DELIVERY-SPEC §4, PR2):
 * (1) ListenerSessionManager.readCanonicalOutboxEntry recovers a sent message's
 *     body by id (the new method the redeliver fn depends on), and
 * (2) the A2ARedeliverySentinel's redeliver path — wired exactly as in server.ts
 *     (read the body from the canonical outbox, re-send via the relay) — actually
 *     recovers the body and re-emits it, with the delivery tracker advancing the
 *     attempt. This is the test that catches the redeliver wiring being a no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ListenerSessionManager } from '../../src/threadline/ListenerSessionManager.js';
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';
import { A2ARedeliverySentinel } from '../../src/monitoring/A2ARedeliverySentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let stateDir: string;
let lsm: ListenerSessionManager;
let tracker: A2ADeliveryTracker;
const FP = '8c7928aa9f04fbda947172a2f9b2d81a';

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-redeliv-'));
  lsm = new ListenerSessionManager(stateDir, 'test-token');
  tracker = A2ADeliveryTracker.openMemory();
});
afterEach(() => {
  tracker?.close();
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/a2a-redelivery-wiring.test.ts' });
});

describe('ListenerSessionManager.readCanonicalOutboxEntry', () => {
  it('recovers a sent entry by messageId', () => {
    lsm.appendCanonicalOutboxEntry({ from: 'me', senderName: 'me', to: FP, recipientName: 'dawn', threadId: 't1', text: 'hello dawn', messageId: 'm1' });
    const got = lsm.readCanonicalOutboxEntry('m1');
    expect(got).not.toBeNull();
    expect(got!.text).toBe('hello dawn');
    expect(got!.to).toBe(FP);
    expect(got!.threadId).toBe('t1');
  });

  it('returns null for an unknown id and when no outbox exists', () => {
    expect(lsm.readCanonicalOutboxEntry('nope')).toBeNull(); // no outbox file yet
    lsm.appendCanonicalOutboxEntry({ from: 'me', senderName: 'me', to: FP, recipientName: 'dawn', threadId: 't1', text: 'x', messageId: 'm1' });
    expect(lsm.readCanonicalOutboxEntry('absent')).toBeNull();
  });

  it('newest entry wins when an id repeats', () => {
    lsm.appendCanonicalOutboxEntry({ from: 'me', senderName: 'me', to: FP, recipientName: 'dawn', threadId: 't1', text: 'first', messageId: 'm1' });
    lsm.appendCanonicalOutboxEntry({ from: 'me', senderName: 'me', to: FP, recipientName: 'dawn', threadId: 't1', text: 'second', messageId: 'm1' });
    expect(lsm.readCanonicalOutboxEntry('m1')!.text).toBe('second');
  });

  it('skips a malformed line without throwing', () => {
    lsm.appendCanonicalOutboxEntry({ from: 'me', senderName: 'me', to: FP, recipientName: 'dawn', threadId: 't1', text: 'good', messageId: 'm1' });
    fs.appendFileSync(lsm.canonicalOutboxPath, '{ not json\n');
    expect(lsm.readCanonicalOutboxEntry('m1')!.text).toBe('good');
  });
});

describe('A2ARedeliverySentinel redeliver wiring (real outbox + relay)', () => {
  it('recovers the body from the canonical outbox and re-sends it', async () => {
    const NOW = Date.parse('2026-06-06T12:00:00Z');
    const OLD = '2026-06-06T00:00:00Z';
    // A sent message: recorded in the tracker (overdue) AND in the canonical outbox.
    tracker.recordSent({ messageId: 'm1', peerFp: FP, threadId: 't1', sentAt: OLD });
    lsm.appendCanonicalOutboxEntry({ from: 'me', senderName: 'me', to: FP, recipientName: 'dawn', threadId: 't1', text: 'please ack', messageId: 'm1' });

    // The redeliver fn wired exactly as server.ts does it (outbox lookup → relay send).
    const sends: Array<{ to: string; text: string; thread?: string }> = [];
    const fakeRelay = { sendAuto: (to: string, text: string, thread?: string) => { sends.push({ to, text, thread }); return 'mid'; } };
    const sentinel = new A2ARedeliverySentinel({
      tracker,
      redeliver: (entry) => {
        const stored = lsm.readCanonicalOutboxEntry(entry.messageId);
        if (!stored) return false;
        fakeRelay.sendAuto(entry.peerFp, stored.text, entry.threadId ?? stored.threadId);
        return true;
      },
      now: () => NOW,
    }, { enabled: true, ttlMs: 6 * 3600_000, maxAttempts: 5, backoffBaseMs: 60_000, maxRedrivesPerTick: 10, sweepIntervalMs: 60_000 });

    const r = await sentinel.tick();
    expect(r.redelivered).toBe(1);
    expect(sends).toEqual([{ to: FP, text: 'please ack', thread: 't1' }]); // body recovered + re-sent
    expect(tracker.get('m1')!.attempts).toBe(2);                            // attempt advanced
    expect(tracker.get('m1')!.state).toBe('awaiting-ack');                  // still awaiting (not acked)
  });

  it('body missing from outbox → no re-send, message left for escalation (no fabrication)', async () => {
    const NOW = Date.parse('2026-06-06T12:00:00Z');
    tracker.recordSent({ messageId: 'ghost', peerFp: FP, threadId: 't9', sentAt: '2026-06-06T00:00:00Z' });
    // NOT appended to the outbox → readCanonicalOutboxEntry returns null.
    let sendCalls = 0;
    const sentinel = new A2ARedeliverySentinel({
      tracker,
      redeliver: (entry) => {
        const stored = lsm.readCanonicalOutboxEntry(entry.messageId);
        if (!stored) return false;
        sendCalls++; return true;
      },
      now: () => NOW,
    }, { enabled: true, ttlMs: 6 * 3600_000, maxAttempts: 5, backoffBaseMs: 60_000, maxRedrivesPerTick: 10, sweepIntervalMs: 60_000 });
    const r = await sentinel.tick();
    expect(sendCalls).toBe(0);
    expect(r.redelivered).toBe(0);
    expect(tracker.get('ghost')!.attempts).toBe(2); // still advances toward escalation
  });
});
