/**
 * GET /telegram/topics/:id/messages?before= — History scroll-back past the
 * current session's start reads the topic's older messages through the route.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

function app() {
  const calls: Array<{ fn: string; topicId: number; before?: number; limit: number }> = [];
  const telegram = {
    getTopicHistory: (topicId: number, limit: number) => { calls.push({ fn: 'recent', topicId, limit }); return [{ topicId, text: 'recent', timestamp: '2026-11-02T10:00:00.000Z', fromUser: true }]; },
    getTopicHistoryBefore: (topicId: number, before: number, limit: number) => { calls.push({ fn: 'before', topicId, before, limit }); return [{ topicId, text: 'older', timestamp: '2026-10-20T10:00:00.000Z', fromUser: true }]; },
  };
  const ctx = {
    config: { projectName: 'echo', projectDir: '/tmp', stateDir: '/tmp', port: 0, authToken: 't', sessions: {}, scheduler: {} },
    startTime: new Date(), scheduler: null,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
    telegram,
  } as unknown as RouteContext;
  const a = express();
  a.use(express.json());
  a.use(createRoutes(ctx));
  return { a, calls };
}

describe('topic messages scroll-back', () => {
  it('without before: the recent page, as before', async () => {
    const { a, calls } = app();
    const res = await request(a).get('/telegram/topics/127504/messages?limit=50');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(['recent']);
    expect(calls[0]).toMatchObject({ fn: 'recent', topicId: 127504, limit: 50 });
  });
  it('with before (ISO or epoch ms): older messages from the log', async () => {
    const { a, calls } = app();
    const iso = '2026-10-31T00:00:00.000Z';
    const r1 = await request(a).get(`/telegram/topics/127504/messages?limit=50&before=${encodeURIComponent(iso)}`);
    expect(r1.status).toBe(200);
    expect(r1.body.messages.map((m: { text: string }) => m.text)).toEqual(['older']);
    expect(calls[0]).toMatchObject({ fn: 'before', topicId: 127504, before: Date.parse(iso), limit: 50 });
    const r2 = await request(a).get(`/telegram/topics/127504/messages?before=${Date.parse(iso)}`);
    expect(r2.status).toBe(200);
    expect(calls[1]).toMatchObject({ fn: 'before', before: Date.parse(iso) });
  });
  it('a malformed before is refused, not ignored', async () => {
    const { a } = app();
    const res = await request(a).get('/telegram/topics/127504/messages?before=yesterday');
    expect(res.status).toBe(400);
  });
});
