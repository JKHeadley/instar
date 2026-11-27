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

// native-conversation-any-machine-access §3d item 4: the pool shape.
import { createTopicHistoryPoolHandler, TOPIC_HISTORY_POOL_MAX_MESSAGES, type TopicHistoryPoolResponse } from '../../src/core/topicHistoryPull.js';
import { bearerFallbackPermitted } from '../../src/core/poolSignedReads.js';

describe('topic-history-pull, shape: pool', () => {
  const TOKEN = 'tok-0123456789abcdef-secret';
  const clean = (s: string) => s.split(TOKEN).join('[redacted]');
  const poolRow = (i: number, text = `row ${i}`) => ({
    messageId: 100 + i, eventId: `ev-${i}`, fromUser: i % 2 === 0, text, timestamp: new Date(Date.UTC(2026, 10, 11, 0, 0, i)).toISOString(),
    provenance: { kind: 'test' }, origin: { recorded: true },
  });
  type Ok = Extract<TopicHistoryPoolResponse, { ok: true }>;
  const ok = async (p: Promise<TopicHistoryPoolResponse>): Promise<Ok> => { const r = await p; if (!r.ok) throw new Error(JSON.stringify(r)); return r; };

  it('echoes the shape, keeps whole rows with their ids, provenance and origin, and passes the cursor through', async () => {
    const seen: unknown[] = [];
    const h = createTopicHistoryPoolHandler({ clean, readPool: async (q) => { seen.push(q); return [poolRow(1, 'x'.repeat(5000))]; } });
    const r = await ok(h({ topic: 5, limit: 500, before: 1_700_000_000_000, beforeMessageId: 9 }));
    expect(r.shape).toBe('pool');
    expect(r.messages[0]).toMatchObject({ messageId: 101, eventId: 'ev-1', provenance: { kind: 'test' }, origin: { recorded: true } });
    expect((r.messages[0].text as string).length).toBe(5000);
    expect(seen).toEqual([{ topic: 5, limit: TOPIC_HISTORY_POOL_MAX_MESSAGES, before: 1_700_000_000_000, beforeMessageId: 9 }]);
    expect(await h({ topic: 5, beforeMessageId: 9 })).toEqual({ ok: false, reason: 'malformed', shape: 'pool' });
    expect(await createTopicHistoryPoolHandler({ clean, readPool: null })({ topic: 5 })).toEqual({ ok: false, reason: 'no-telegram', shape: 'pool' });
  });

  it('a capped answer keeps the newest rows and returns truncated with the oldest cursor', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => poolRow(i, 'r'.repeat(400)));
    const r = await ok(createTopicHistoryPoolHandler({ clean, maxBytes: 10_000, readPool: async () => rows })({ topic: 5 }));
    expect(r.truncated).toBe(true);
    expect(r.messages[r.messages.length - 1].eventId).toBe('ev-49');
    expect(r.oldest).toEqual({ before: Date.parse(String(r.messages[0].timestamp)), beforeMessageId: r.messages[0].messageId });
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(10_000);
  });

  it('one row larger than the cap between two ordinary rows is returned alone with rowTruncated; its continuation reads the rest byte for byte on UTF-8 boundaries; a token across the cut is in neither piece; paging with before reaches the older row without the remainder', async () => {
    const big = `${'漢é'.repeat(2000)}${TOKEN}${'ü'.repeat(3000)}`;
    const all = [poolRow(1, 'older'), poolRow(2, big), poolRow(3, 'newer')];
    // A minimal history store: rows strictly before the cursor, oldest first.
    const readPool = async (q: { limit: number; before?: number }) => all.filter((m) => q.before === undefined || Date.parse(m.timestamp) < q.before).slice(-q.limit);
    const maxBytes = 8 * 1024 + 3000;
    const h = createTopicHistoryPoolHandler({ clean, maxBytes, readPool });
    const p1 = await ok(h({ topic: 5, limit: 2 }));
    expect(p1.messages.map((m) => m.text)).toEqual(['newer']);
    const p2 = await ok(h({ topic: 5, ...p1.oldest }));
    expect(p2.messages).toHaveLength(1);
    const marker = p2.rowTruncated!;
    expect(marker.row).toBe('ev-2');
    expect(marker.from).toBe(0);
    const redacted = clean(big);
    expect(marker.totalBytes).toBe(Buffer.byteLength(redacted));
    const pieces = [p2.messages[0].text as string];
    let to = marker.to;
    for (let g = 0; to < marker.totalBytes && g < 50; g++) {
      const c = await ok(h({ topic: 5, ...p1.oldest, row: 'ev-2', byteFrom: to }));
      expect(c.rowTruncated!.from).toBe(to);
      expect(c.messages[0].text).not.toContain('�');
      pieces.push(c.messages[0].text as string);
      to = c.rowTruncated!.to;
    }
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(redacted);
    for (const p of pieces) expect(p).not.toContain(TOKEN.slice(0, 12));
    const p3 = await ok(h({ topic: 5, ...p2.oldest }));
    expect(p3.messages.map((m) => m.text)).toEqual(['older']);
    expect(await h({ topic: 5, ...p1.oldest, row: 'ev-2', byteFrom: 1 })).toEqual({ ok: false, reason: 'bad-byte-range', shape: 'pool' });
    expect(await h({ topic: 5, ...p1.oldest, row: 'ev-99' })).toEqual({ ok: false, reason: 'row-gone', shape: 'pool' });
  });

  it('an older peer: a default-shape answer (no shape echo) permits the bearer hop; a pool answer does not', () => {
    const older = createTopicHistoryPullHandler({ readHistory: () => [row('hi')] })({ topic: 5 });
    expect(bearerFallbackPermitted('historyPool', { status: 200, ok: true, result: older }, '1.3.1700')).toBe(true);
    expect(bearerFallbackPermitted('historyPool', { status: 200, ok: true, result: { ok: true, shape: 'pool', messages: [] } }, '1.3.1740')).toBe(false);
  });
});
