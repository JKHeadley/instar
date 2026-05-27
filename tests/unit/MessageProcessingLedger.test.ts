/**
 * Tier-1 tests for MessageProcessingLedger — the no-loss / no-duplicate-reply
 * core (spec §8 G3a). Real SQLite (in-memory). Both sides of every boundary:
 * redelivery dropped, cursor advances only on durable completion, stuck-
 * processing re-run, dual-medium remote marker.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  MessageProcessingLedger,
  computeReplyIdempotencyKey,
} from '../../src/messaging/MessageProcessingLedger.js';

let ledger: MessageProcessingLedger;
afterEach(() => ledger?.close());

describe('MessageProcessingLedger', () => {
  it('records a new event as received (firstSeen)', () => {
    ledger = MessageProcessingLedger.openMemory();
    const r = ledger.record('upd-1', { platform: 'telegram', topic: '13481' });
    expect(r.firstSeen).toBe(true);
    expect(r.state).toBe('received');
    expect(ledger.isActedOn('upd-1')).toBe(false);
  });

  it('a redelivery of an acted-on event is recognized and NOT first-seen', () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.record('upd-1', { platform: 'telegram' });
    ledger.beginProcessing('upd-1', 1);
    ledger.commitReply('upd-1', computeReplyIdempotencyKey('upd-1', 0), 1);
    // Telegram redelivers the same update.
    const again = ledger.record('upd-1', { platform: 'telegram' });
    expect(again.firstSeen).toBe(false);
    expect(again.state).toBe('reply_committed');
    expect(ledger.isActedOn('upd-1')).toBe(true); // caller drops it
  });

  it('beginProcessing returns false once acted on (no double-act)', () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.record('upd-2', { platform: 'telegram' });
    ledger.beginProcessing('upd-2', 1);
    ledger.commitReply('upd-2', computeReplyIdempotencyKey('upd-2', 0), 1);
    expect(ledger.beginProcessing('upd-2', 2)).toBe(false);
  });

  it('cursor advances only from reply_committed', () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.record('upd-3', { platform: 'telegram' });
    ledger.advanceCursor('upd-3'); // still 'received' → no-op
    expect(ledger.get('upd-3')!.state).toBe('received');
    ledger.beginProcessing('upd-3', 1);
    ledger.commitReply('upd-3', computeReplyIdempotencyKey('upd-3', 0), 1);
    ledger.advanceCursor('upd-3');
    expect(ledger.get('upd-3')!.state).toBe('cursor_advanced');
  });

  it('commitReply is idempotent — committing twice keeps the first marker', () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.record('upd-4', { platform: 'telegram' });
    ledger.beginProcessing('upd-4', 1);
    const key = computeReplyIdempotencyKey('upd-4', 0);
    ledger.commitReply('upd-4', key, 1);
    ledger.commitReply('upd-4', 'DIFFERENT', 9); // must be ignored
    const row = ledger.get('upd-4')!;
    expect(row.replyIdempotencyKey).toBe(key);
    expect(row.replyEpoch).toBe(1);
  });

  it('reclaimStuck finds processing entries past maxProcessingMs', () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.record('upd-5', { platform: 'telegram', input: '{"text":"hi"}' });
    ledger.beginProcessing('upd-5', 1);
    const started = Date.parse(ledger.get('upd-5')!.processingStartedAt!);
    // Not yet stuck.
    expect(ledger.reclaimStuck(60_000, started + 1_000)).toHaveLength(0);
    // Past the threshold → reclaimable, with stored input for re-run.
    const stuck = ledger.reclaimStuck(60_000, started + 61_000);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].dedupeKey).toBe('upd-5');
    expect(stuck[0].inputSnapshot).toBe('{"text":"hi"}');
  });

  it('a re-claimed stuck entry can be re-processed by the new holder', () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.record('upd-6', { platform: 'telegram' });
    ledger.beginProcessing('upd-6', 1); // old holder, epoch 1
    // New holder (epoch 2) re-claims and commits.
    expect(ledger.beginProcessing('upd-6', 2)).toBe(true);
    expect(ledger.get('upd-6')!.attempts).toBe(2);
    ledger.commitReply('upd-6', computeReplyIdempotencyKey('upd-6', 0), 2);
    expect(ledger.get('upd-6')!.replyEpoch).toBe(2);
  });

  it('applyRemoteReplyMarker prevents a failover re-send (dual-medium marker)', () => {
    ledger = MessageProcessingLedger.openMemory();
    // We received it but had not replied when the other machine did + propagated.
    ledger.record('upd-7', { platform: 'telegram' });
    ledger.applyRemoteReplyMarker('upd-7', {
      platform: 'telegram',
      replyIdempotencyKey: computeReplyIdempotencyKey('upd-7', 0),
      epoch: 3,
    });
    expect(ledger.isActedOn('upd-7')).toBe(true);
    expect(ledger.beginProcessing('upd-7', 4)).toBe(false); // won't re-send
  });

  it('applyRemoteReplyMarker creates the entry if the event was unknown locally', () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.applyRemoteReplyMarker('upd-8', {
      platform: 'slack',
      replyIdempotencyKey: 'k8',
      epoch: 2,
    });
    expect(ledger.isActedOn('upd-8')).toBe(true);
  });

  it('idempotency key is deterministic across machines', () => {
    expect(computeReplyIdempotencyKey('upd-x', 0)).toBe(computeReplyIdempotencyKey('upd-x', 0));
    expect(computeReplyIdempotencyKey('upd-x', 0)).not.toBe(computeReplyIdempotencyKey('upd-x', 1));
  });
});
