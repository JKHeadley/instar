/**
 * docs/specs/mobile-pairing-outcome-notice.md §3.4: the reply-route answer table, the outbox
 * outcome mapping, and the adapter's send/escalate behaviour.
 */
import { describe, it, expect, vi } from 'vitest';
import { classifyReplyAnswer, classifyOperationOutcome, createPairingOutcomeNotice } from '../../src/server/pairingOutcomeNotice.js';

describe('classifyReplyAnswer', () => {
  it('2xx delivered is sent; a suppressed duplicate counts as sent; quiet filing is quiet', () => {
    expect(classifyReplyAnswer(200, { ok: true })).toEqual({ kind: 'sent' });
    expect(classifyReplyAnswer(200, { ok: true, suppressedDuplicate: true })).toEqual({ kind: 'sent' });
    expect(classifyReplyAnswer(200, { ok: true, delivered: false, recorded: true, quietId: 'q1' })).toEqual({ kind: 'quiet' });
  });

  it('a hold with delivered:true is sent; with an operationId is handed off; without one is a refusal', () => {
    expect(classifyReplyAnswer(409, { error: 'telegram-origin-held', delivered: true })).toEqual({ kind: 'sent' });
    expect(classifyReplyAnswer(409, { error: 'telegram-origin-held', outcome: 'held', operationId: 'op-123456', retryable: false })).toEqual({ kind: 'handed-off', operationId: 'op-123456' });
    expect(classifyReplyAnswer(409, { error: 'telegram-origin-held', outcome: 'held', reason: 'logical-send-content-conflict', operationId: null }).kind).toBe('failed');
    expect(classifyReplyAnswer(409, { error: 'telegram-origin-held', outcome: 'held', reason: 'invalid-automation-credential' }).kind).toBe('failed');
  });

  it('transient answers retry', () => {
    expect(classifyReplyAnswer(409, { error: 'telegram-origin-held', reason: 'notification-server-unavailable', operationId: 'op-1' }).kind).toBe('retry');
    expect(classifyReplyAnswer(409, { error: 'content-dedup-unavailable' }).kind).toBe('retry');
    expect(classifyReplyAnswer(409, { error: 'duplicate-suppression-unrecorded' }).kind).toBe('retry');
    expect(classifyReplyAnswer(409, { error: 'standing-down' }).kind).toBe('retry');
    expect(classifyReplyAnswer(429, null).kind).toBe('retry');
    expect(classifyReplyAnswer(502, null).kind).toBe('retry');
  });

  it('other refusals and Telegram not configured are final', () => {
    expect(classifyReplyAnswer(503, { error: 'Telegram not configured' }).kind).toBe('failed');
    expect(classifyReplyAnswer(422, { error: 'tone-gate-blocked' }).kind).toBe('failed');
    expect(classifyReplyAnswer(400, { error: 'bad' }).kind).toBe('failed');
  });
});

describe('classifyOperationOutcome', () => {
  it('maps the outbox answers', () => {
    expect(classifyOperationOutcome({ outcome: 'delivered' })).toBe('delivered');
    expect(classifyOperationOutcome({ outcome: 'delivered', reason: 'duplicate-content' })).toBe('delivered');
    expect(classifyOperationOutcome({ outcome: 'partially-delivered' })).toBe('delivered');
    expect(classifyOperationOutcome({ outcome: 'not-delivered', reason: 'quiet-notification-recorded' })).toBe('quiet');
    expect(classifyOperationOutcome({ outcome: 'not-delivered', reason: 'policy' })).toBe('failed');
    expect(classifyOperationOutcome({ outcome: 'unknown' })).toBe('unknown');
    expect(classifyOperationOutcome({ outcome: 'pending' })).toBe('unknown');
    expect(classifyOperationOutcome(null)).toBe('unknown');
  });
});

describe('createPairingOutcomeNotice', () => {
  function make(post: ReturnType<typeof vi.fn>, upsert = vi.fn(async () => ({}))) {
    return createPairingOutcomeNotice({
      post: post as never, port: 1, authToken: 't', available: () => true, recentOperatorInbound: () => null, upsertAttention: upsert,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ outcome: 'delivered' }), { status: 200 })) as never,
    });
  }

  it('sends the system header, the producer source and the anchor', async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const n = make(post);
    expect(await n.send(7, 'A phone was paired with Echo.', 'mobile-pairing-outcome:w1', '555')).toEqual({ kind: 'sent' });
    const [topicId, body, logical, opts] = post.mock.calls[0]!;
    expect(topicId).toBe(7);
    expect(logical).toBe('mobile-pairing-outcome:w1');
    expect(body).toEqual({ text: 'A phone was paired with Echo.', metadata: { source: 'mobile-pairing-outcome', inboundMessageId: '555' } });
    expect((opts as { headers: Record<string, string> }).headers['X-Instar-System']).toBe('true');
  });

  it('omits the anchor when there is none, and a thrown post is a retry', async () => {
    const post = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const n = make(post);
    expect((await n.send(7, 'x', 'l', null)).kind).toBe('retry');
    expect((post.mock.calls[0]![1] as { metadata: Record<string, unknown> }).metadata.inboundMessageId).toBeUndefined();
  });

  it('reads an operation outcome and escalates one attention item per topic', async () => {
    const upsert = vi.fn(async () => ({}));
    const n = make(vi.fn(), upsert);
    expect(await n.checkOperation('op-123456')).toBe('delivered');
    expect(await n.escalate(9, ['line one', 'line two'])).toBe(true);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'mobile-pairing-outcome:9', summary: 'line one\nline two', topicId: 9 }));
    const failing = make(vi.fn(), vi.fn(async () => { throw new Error('no'); }));
    expect(await failing.escalate(9, ['x'])).toBe(false);
  });
});
