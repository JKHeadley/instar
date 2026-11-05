/** Moved-conversation history: the serve-side caps and the signed-then-bearer order. */
import { describe, it, expect, vi } from 'vitest';
import {
  createTopicHistoryPullHandler,
  pullMovedTopicHistory,
  TOPIC_HISTORY_PULL_MAX_BYTES,
  TOPIC_HISTORY_PULL_MAX_MESSAGES,
  TOPIC_HISTORY_PULL_MAX_TEXT,
} from '../../src/core/topicHistoryPull.js';

const row = (text: string) => ({ fromUser: true, text, senderName: 'A', timestamp: '2026-11-04T10:00:00Z', telegramUserId: 7, viewSignature: 'secret' });

describe('createTopicHistoryPullHandler', () => {
  it('serves only the fields the context block reads', () => {
    const res = createTopicHistoryPullHandler({ readHistory: () => [row('hi')] })({ topic: 5 });
    expect(res).toEqual({ ok: true, messages: [{ fromUser: true, text: 'hi', senderName: 'A', timestamp: '2026-11-04T10:00:00Z' }] });
  });
  it('refuses a malformed topic and a machine with no Telegram', () => {
    expect(createTopicHistoryPullHandler({ readHistory: () => [] })({ topic: '5' })).toEqual({ ok: false, reason: 'malformed' });
    expect(createTopicHistoryPullHandler({ readHistory: null })({ topic: 5 })).toEqual({ ok: false, reason: 'no-telegram' });
  });
  it('clamps the requested limit on both sides', () => {
    const read = vi.fn(() => []);
    const handler = createTopicHistoryPullHandler({ readHistory: read });
    handler({ topic: 5, limit: 100000 });
    handler({ topic: 5, limit: 0 });
    expect(read.mock.calls.map((c) => (c as unknown[])[1])).toEqual([TOPIC_HISTORY_PULL_MAX_MESSAGES, 1]);
  });
  it('caps text per message and drops the oldest past the size cap, keeping the newest', () => {
    const big = Array.from({ length: 50 }, (_, i) => row(`${i}:`.padEnd(TOPIC_HISTORY_PULL_MAX_TEXT + 500, '€')));
    const res = createTopicHistoryPullHandler({ readHistory: () => big })({ topic: 5 });
    if (!res.ok) throw new Error('expected ok');
    expect(res.messages[0].text!.length).toBe(TOPIC_HISTORY_PULL_MAX_TEXT);
    expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(TOPIC_HISTORY_PULL_MAX_BYTES);
    expect(res.messages.length).toBeLessThan(50);
    expect(res.messages.at(-1)!.text!.startsWith('49:')).toBe(true);
  });
});

describe('pullMovedTopicHistory', () => {
  const ok = { ok: true, result: { ok: true, messages: [row('signed')] } };
  it('uses the signed pull and never sends the bearer token when it works', async () => {
    const bearerFetch = vi.fn(async () => [row('bearer')]);
    const res = await pullMovedTopicHistory({ signedPull: async () => ok, bearerFetch }, 5);
    expect(res.via).toBe('signed');
    expect(res.messages[0].text).toBe('signed');
    expect(bearerFetch).not.toHaveBeenCalled();
  });
  it.each([
    ['the holder has no such verb', async () => ({ ok: false })],
    ['the holder has no Telegram', async () => ({ ok: true, result: { ok: false, reason: 'no-telegram' } })],
    ['the transport throws', async () => { throw new Error('boom'); }],
    ['no holder is known', async () => null],
  ])('falls back to the bearer call when %s', async (_name, signedPull) => {
    const res = await pullMovedTopicHistory({ signedPull, bearerFetch: async () => [row('bearer')] }, 5);
    expect(res).toMatchObject({ via: 'bearer', messages: [{ text: 'bearer' }] });
  });
  it('an empty signed answer is an answer, not a failure', async () => {
    const bearerFetch = vi.fn(async () => [row('bearer')]);
    const res = await pullMovedTopicHistory({ signedPull: async () => ({ ok: true, result: { ok: true, messages: [] } }), bearerFetch }, 5);
    expect(res).toEqual({ messages: [], via: 'signed' });
    expect(bearerFetch).not.toHaveBeenCalled();
  });
  it('never throws, and says so in the log when both routes fail', async () => {
    const log = vi.fn();
    const res = await pullMovedTopicHistory({ signedPull: async () => { throw new Error('a'); }, bearerFetch: async () => { throw new Error('b'); }, log }, 5);
    expect(res).toEqual({ messages: [], via: 'none' });
    expect(log.mock.calls.at(-1)![0]).toContain('starts without it');
  });
  it('treats a peer answer as untrusted: wrong-shaped rows are dropped', async () => {
    const res = await pullMovedTopicHistory({ signedPull: async () => ({ ok: true, result: { ok: true, messages: [null, 'x', { text: 'no fromUser' }, row('good')] } }), bearerFetch: null }, 5);
    expect(res.messages.map((m) => m.text)).toEqual(['good']);
  });
});
