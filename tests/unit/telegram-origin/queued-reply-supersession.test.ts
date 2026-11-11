import { describe, expect, it, vi } from 'vitest';
import { QUEUED_REPLY_PEER_WAIT_MS, queuedReplyOvertaken, reviewQueuedReplyHistory } from '../../../src/messaging/telegram-origin/QueuedReplySupersession.js';
import { TelegramOriginRuntime } from '../../../src/messaging/telegram-origin/TelegramOriginRuntime.js';

const prepared = Date.parse('2026-11-05T02:08:47.000Z');
const message = (timestamp: string, fromUser: boolean, provenance?: string) => ({ timestamp, fromUser, provenance });

describe('queued reply supersession', () => {
  it('retires the App status queued before Justin answered and Echo corrected it', () => {
    expect(queuedReplyOvertaken(prepared, [
      message('2026-11-05T02:08:50.000Z', true, 'user'),
      message('2026-11-05T02:11:46.000Z', false, 'agent'),
    ])).toBe(true);
  });

  it('retires a shorter correction when a newer agent correction already arrived', () => {
    expect(queuedReplyOvertaken(prepared, [message('2026-11-05T02:32:13.000Z', false, 'agent')])).toBe(true);
  });

  it('keeps a queued reply when only its delivery notices followed it', () => {
    expect(queuedReplyOvertaken(prepared, [
      message('2026-11-05T02:30:38.000Z', false, 'automation'),
      message('2026-11-05T02:31:00.000Z', false, 'automation'),
    ])).toBe(false);
  });

  // Regression, 2026-11-11 04:40Z (topic 141014): two replies were held by the
  // Studio's send capacity; the operator wrote "Checking in here" while waiting,
  // and the next retry retired both as overtaken. A user who checks in is still
  // waiting for the held answer, so a user message alone must never retire it.
  it('keeps a held reply when only the user wrote after it (a check-in)', () => {
    const drafted = Date.parse('2026-11-11T04:21:34.000Z');
    const checkIn = [message('2026-11-11T04:40:13.000Z', true, 'user')];
    expect(queuedReplyOvertaken(drafted, checkIn)).toBe(false);
    expect(reviewQueuedReplyHistory({ preparedAt: drafted, local: checkIn, pooled: checkIn, failedPeers: 0 })).toBe('deliver');
  });

  it('a user message never counts even when mislabelled as agent provenance', () => {
    expect(queuedReplyOvertaken(prepared, [message('2026-11-05T02:20:00.000Z', true, 'agent')])).toBe(false);
  });

  it('does not infer a newer message from missing or malformed history', () => {
    expect(queuedReplyOvertaken(prepared, [])).toBe(false);
    expect(queuedReplyOvertaken(prepared, [message('unknown', true)])).toBe(false);
    expect(queuedReplyOvertaken(prepared, [message('2026-11-05T02:08:46.000Z', true)])).toBe(false);
  });

  it('uses pooled history when the local machine missed the newer answer', () => {
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [
      message('2026-11-05T02:11:46.000Z', false, 'agent'),
    ], failedPeers: 0 })).toBe('retire');
  });

  it('holds during incomplete pool coverage instead of sending a possibly stale reply', () => {
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [], failedPeers: 1, now: prepared + 60_000 })).toBe('hold');
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [] })).toBe('hold');
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [
      message('2026-11-05T02:30:00.000Z', false, 'automation'),
    ], poolPageLimit: 1 })).toBe('hold');
  });

  it('stops waiting for an unreachable machine once the bound passes', () => {
    const review = (now: number) => reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [], failedPeers: 1, now });
    expect(review(prepared + QUEUED_REPLY_PEER_WAIT_MS - 1)).toBe('hold');
    expect(review(prepared + QUEUED_REPLY_PEER_WAIT_MS)).toBe('deliver');
  });

  it('uses the real clock when the caller passes none, as the server does', () => {
    vi.useFakeTimers();
    try {
      const review = () => reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [], failedPeers: 1 });
      vi.setSystemTime(prepared + QUEUED_REPLY_PEER_WAIT_MS - 1);
      expect(review()).toBe('hold');
      vi.setSystemTime(prepared + QUEUED_REPLY_PEER_WAIT_MS);
      expect(review()).toBe('deliver');
    } finally { vi.useRealTimers(); }
  });

  it('the bound never overrides evidence or an unread history page', () => {
    const late = prepared + QUEUED_REPLY_PEER_WAIT_MS * 4;
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [
      message('2026-11-05T02:11:46.000Z', false, 'agent'),
    ], failedPeers: 1, now: late })).toBe('retire');
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [], now: late })).toBe('hold');
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [
      message('2026-11-05T02:30:00.000Z', false, 'automation'),
    ], failedPeers: 1, poolPageLimit: 1, now: late })).toBe('hold');
  });

  it('delivers when complete pooled history has no newer conversation', () => {
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [
      message('2026-11-05T02:08:46.000Z', true, 'user'),
      message('2026-11-05T02:30:00.000Z', false, 'automation'),
    ], failedPeers: 0 })).toBe('deliver');
    expect(reviewQueuedReplyHistory({ preparedAt: prepared, local: [], pooled: [
      message('2026-11-05T02:30:00.000Z', true, 'user'),
    ], failedPeers: 0 })).toBe('deliver');
  });

  it('reconciles a forwarded unknown outcome, then retires it after definite nonacceptance', async () => {
    const reviewQueuedReply = vi.fn(async () => 'retire' as const);
    const recordOperationState = vi.fn(async () => true);
    const runtime = Object.create(TelegramOriginRuntime.prototype) as TelegramOriginRuntime;
    Object.assign(runtime, { options: { reviewQueuedReply }, store: { recordOperationState } });
    const operation = { record: { operationId: 'old-reply', producerKind: 'session', destination: {
      chatId: '-100123', topicId: '42' } }, admission: { preparedAt: prepared, children: [{ materializations: [
      { requestJson: JSON.stringify({ method: 'sendMessage' }) },
    ] }] } } as never;
    const audit = { operation: { state: 'held' }, children: [], attempts: [
      { outcome: 'outcome-unknown' },
    ] } as never;
    const row = { holdDetail: { lastAttempt: 'outcome-unknown' } } as never;
    const gate = (runtime as unknown as { allowQueuedRecovery: (
      operation: unknown, row: unknown, audit: unknown) => Promise<boolean> }).allowQueuedRecovery.bind(runtime);
    expect(await gate(operation, row, audit)).toBe(true);
    expect(reviewQueuedReply).not.toHaveBeenCalled();
    expect(await gate(operation, { holdDetail: { lastAttempt: 'refused' } }, audit)).toBe(false);
    expect(reviewQueuedReply).toHaveBeenCalledOnce();
    expect(recordOperationState).toHaveBeenCalledWith({ operationId: 'old-reply', state: 'suppressed', holdReason: 'overtaken-reply' });
  });

  it('checks a replacement forward against the original session draft time', async () => {
    const reviewQueuedReply = vi.fn(async () => 'retire' as const);
    const recordOperationState = vi.fn(async () => true);
    const runtime = Object.create(TelegramOriginRuntime.prototype) as TelegramOriginRuntime;
    Object.assign(runtime, { options: { reviewQueuedReply }, store: { recordOperationState } });
    const operation = { record: { operationId: 'replacement', producerKind: 'server-automation', destination: {
      chatId: '-100123', topicId: '42' } }, admission: { preparedAt: prepared + 60_000, children: [{ materializations: [
      { requestJson: JSON.stringify({ method: 'sendMessage' }) },
    ] }] } } as never;
    const row = { holdDetail: { lastAttempt: 'refused', authoredProducerKind: 'session', authoredPreparedAt: prepared } } as never;
    const audit = { operation: { state: 'held' }, children: [], attempts: [] } as never;
    const gate = (runtime as unknown as { allowQueuedRecovery: (
      operation: unknown, row: unknown, audit: unknown) => Promise<boolean> }).allowQueuedRecovery.bind(runtime);
    expect(await gate(operation, row, audit)).toBe(false);
    expect(reviewQueuedReply).toHaveBeenCalledWith(expect.objectContaining({ preparedAt: prepared }));
    expect(recordOperationState).toHaveBeenCalledWith({ operationId: 'replacement', state: 'suppressed', holdReason: 'overtaken-reply' });
  });
});
