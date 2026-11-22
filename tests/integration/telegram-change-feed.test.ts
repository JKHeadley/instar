/**
 * Exact final-page payload differences preserve all rows from the previous full-page read,
 * independently of timestamp order, and retain device shaping and pool merge semantics.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const NOW = Date.parse('2026-11-22T08:00:00.000Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const ROWS = [
  { messageId: 10, topicId: 145738, text: 'ten minutes ago', timestamp: at(10 * 60_000), fromUser: true, sessionName: null, eventId: 'ev-old' },
  { messageId: 11, topicId: 145738, text: 'ninety seconds ago', timestamp: at(90_000), fromUser: false, sessionName: null },
  { messageId: 12, topicId: 145738, text: 'just now', timestamp: at(0), fromUser: true, sessionName: null },
];

function app(opts: { device?: boolean; rows?: Array<Record<string, unknown>>; deliveryState?: () => string } = {}) {
  const telegram = {
    getTopicHistory: (_topicId: number, limit: number) => (opts.rows ?? ROWS).slice(-limit),
    getTopicHistoryBefore: () => [],
  };
  // A minimal app-conversation store: the old row was sent from the app, so the device join knows it.
  const appConversations = {
    store: {
      getEvent: (_key: string, eventId: string) => (eventId === 'ev-old' ? { kind: 'message', text: 'ten minutes ago', messageId: 'm-old' } : null),
      deliveryState: opts.deliveryState ?? (() => 'delivered'),
      browseMessages: () => ({ messages: [{ eventId: 'ev-old', role: 'operator', deliveryState: 'delivered', text: 'ten minutes ago', at: at(10 * 60_000), messageId: 'm-old' }], nextBefore: null }),
      getPlatformMedia: () => null,
    },
    verify: () => 'verified',
    originApprovedVia: () => null,
    originClient: () => null,
  };
  const ctx = {
    config: { projectName: 'echo', projectDir: '/tmp', stateDir: '/tmp', port: 0, authToken: 't', sessions: {}, scheduler: {} },
    startTime: new Date(), scheduler: null,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
    telegram,
    ...(opts.device ? { appConversations } : {}),
    resolvePeerUrls: () => [],
  } as unknown as RouteContext;
  const a = express();
  a.use(express.json());
  if (opts.device) a.use((req, _res, next) => { (req as unknown as { instarPrincipal: unknown }).instarPrincipal = { kind: 'device' }; next(); });
  a.use(createRoutes(ctx));
  return a;
}

const texts = (body: { messages: Array<{ text: string }> }) => body.messages.map((m) => m.text);

const known = (hashes: string[]) => encodeURIComponent(hashes.join(','));
const path = '/telegram/topics/145738/messages?limit=50';

describe('Telegram change feed', () => {
  it('a plain read is unchanged, with no changeFeed field', async () => {
    const res = await request(app()).get(path);
    expect(res.status).toBe(200);
    expect(texts(res.body)).toEqual(['ten minutes ago', 'ninety seconds ago', 'just now']);
    expect(res.body.changeFeed).toBeUndefined();
  });

  it('starts with a full baseline and omits only exact unchanged rows on the next poll', async () => {
    const a = app();
    const first = await request(a).get(`${path}&knownRows=`);
    expect(first.status).toBe(200);
    expect(texts(first.body)).toEqual(ROWS.map((r) => r.text));
    expect(first.body.changeFeed.rowHashes).toHaveLength(3);
    const next = await request(a).get(`${path}&knownRows=${known(first.body.changeFeed.rowHashes)}`);
    expect(next.status).toBe(200);
    expect(next.body.messages).toEqual([]);
    expect(next.body.changeFeed).toEqual(first.body.changeFeed);
  });

  it('includes a newly arrived row even when its timestamp is older than every known row', async () => {
    const rows: Array<Record<string, unknown>> = ROWS.map((r) => ({ ...r }));
    const a = app({ rows });
    const first = await request(a).get(`${path}&knownRows=`);
    rows.push({ ...ROWS[0], messageId: 13, eventId: 'late', text: 'arrived late', timestamp: at(60 * 60_000) });
    const next = await request(a).get(`${path}&knownRows=${known(first.body.changeFeed.rowHashes)}`);
    expect(next.status).toBe(200);
    expect(texts(next.body)).toEqual(['arrived late']);
    expect(next.body.changeFeed.rowHashes).toHaveLength(4);
  });

  it('a future-dated known row never hides ordinary-time arrivals', async () => {
    const rows: Array<Record<string, unknown>> = [{ ...ROWS[0], timestamp: new Date(NOW + 86_400_000).toISOString() }];
    const a = app({ rows });
    const first = await request(a).get(`${path}&knownRows=`);
    rows.push({ ...ROWS[2] });
    const next = await request(a).get(`${path}&knownRows=${known(first.body.changeFeed.rowHashes)}`);
    expect(texts(next.body)).toEqual(['just now']);
  });

  it('hashes the complete pool answer after merge and device joins', async () => {
    const a = app({ device: true });
    const first = await request(a).get(`${path}&scope=pool&knownRows=`);
    expect(first.status).toBe(200);
    expect(first.body.pool).toBeDefined();
    expect(first.body.messages.find((m: { eventId: string }) => m.eventId === 'ev-old')).toMatchObject({ messageId: 10, originVerified: 'verified' });
    const next = await request(a).get(`${path}&scope=pool&knownRows=${known(first.body.changeFeed.rowHashes)}`);
    expect(next.status).toBe(200);
    expect(next.body.messages).toEqual([]);
    expect(next.body.pool).toBeDefined();
  });

  it('resends a device row when only its delivery state changes', async () => {
    let delivery = 'pending';
    const a = app({ device: true, deliveryState: () => delivery });
    const first = await request(a).get(`${path}&knownRows=`);
    delivery = 'delivered';
    const next = await request(a).get(`${path}&knownRows=${known(first.body.changeFeed.rowHashes)}`);
    expect(next.status).toBe(200);
    expect(next.body.messages).toHaveLength(1);
    expect(next.body.messages[0]).toMatchObject({ eventId: 'ev-old', messageId: 10, deliveryState: 'delivered', originVerified: 'verified' });
  });

  it('rejects malformed hash sets and combinations with scroll-back', async () => {
    const a = app();
    for (const query of ['knownRows=nope', 'knownRows[]=x', `knownRows=${'a'.repeat(6500)}`, `knownRows=&before=${NOW}`, `knownRows=&before=${NOW}&beforeMessageId=12`]) {
      expect((await request(a).get(`${path}&${query}`)).status).toBe(400);
    }
  });
});
