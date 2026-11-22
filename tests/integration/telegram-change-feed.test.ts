/**
 * GET /telegram/topics/:id/messages?after= — the change feed (docs/specs/telegram-slack-change-feed.md).
 * Only rows at or after `after` minus the two-minute lookback come back; the window trims the
 * finished answer (after the device join and the pool merge), never the rows those steps read.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { CHANGE_FEED_LOOKBACK_MS } from '../../src/server/changeFeed.js';

const NOW = Date.parse('2026-11-22T08:00:00.000Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const ROWS = [
  { messageId: 10, topicId: 145738, text: 'ten minutes ago', timestamp: at(10 * 60_000), fromUser: true, sessionName: null, eventId: 'ev-old' },
  { messageId: 11, topicId: 145738, text: 'ninety seconds ago', timestamp: at(90_000), fromUser: false, sessionName: null },
  { messageId: 12, topicId: 145738, text: 'just now', timestamp: at(0), fromUser: true, sessionName: null },
];

function app(opts: { device?: boolean } = {}) {
  const telegram = {
    getTopicHistory: (_topicId: number, limit: number) => ROWS.slice(-limit),
    getTopicHistoryBefore: () => [],
  };
  // A minimal app-conversation store: the old row was sent from the app, so the device join knows it.
  const appConversations = {
    store: {
      getEvent: (_key: string, eventId: string) => (eventId === 'ev-old' ? { kind: 'message', text: 'ten minutes ago', messageId: 'm-old' } : null),
      deliveryState: () => 'delivered',
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

describe('Telegram change feed', () => {
  it('a plain read is unchanged: the newest page, no changeFeed field', async () => {
    const res = await request(app()).get('/telegram/topics/145738/messages?limit=50');
    expect(res.status).toBe(200);
    expect(texts(res.body)).toEqual(['ten minutes ago', 'ninety seconds ago', 'just now']);
    expect(res.body.changeFeed).toBeUndefined();
  });

  it('after: only rows inside the lookback window, oldest first, with the window echoed', async () => {
    const res = await request(app()).get(`/telegram/topics/145738/messages?limit=50&after=${encodeURIComponent(at(0))}`);
    expect(res.status).toBe(200);
    expect(texts(res.body)).toEqual(['ninety seconds ago', 'just now']);
    expect(res.body.changeFeed).toEqual({ since: at(CHANGE_FEED_LOOKBACK_MS), lookbackMs: CHANGE_FEED_LOOKBACK_MS });
    expect(res.body.historyCursorVersion).toBe(2);
  });

  it('after accepts epoch milliseconds too', async () => {
    const res = await request(app()).get(`/telegram/topics/145738/messages?after=${NOW + 10 * 60_000}`);
    expect(res.status).toBe(200);
    expect(texts(res.body)).toEqual([]);
  });

  it('the pool read applies the same window to the merged answer', async () => {
    const res = await request(app()).get(`/telegram/topics/145738/messages?scope=pool&after=${encodeURIComponent(at(0))}`);
    expect(res.status).toBe(200);
    expect(texts(res.body)).toEqual(['ninety seconds ago', 'just now']);
    expect(res.body.changeFeed?.lookbackMs).toBe(CHANGE_FEED_LOOKBACK_MS);
    expect(res.body.pool).toBeDefined();
  });

  it('a device read never gets a weaker store copy of an app-sent row from outside the window', async () => {
    const res = await request(app({ device: true })).get(`/telegram/topics/145738/messages?after=${encodeURIComponent(at(0))}`);
    expect(res.status).toBe(200);
    const rows = res.body.messages as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.text)).toEqual(['ninety seconds ago', 'just now']);
    expect(rows.some((r) => r.eventId === 'ev-old' || r.fromStore === true)).toBe(false);
  });

  it('refuses a malformed after, and after combined with before', async () => {
    const a = app();
    expect((await request(a).get('/telegram/topics/145738/messages?after=soon')).status).toBe(400);
    expect((await request(a).get(`/telegram/topics/145738/messages?after=${NOW}&before=${NOW}`)).status).toBe(400);
  });
});
