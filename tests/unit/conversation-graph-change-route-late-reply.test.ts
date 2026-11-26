import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConversationGraphChangeRouter } from '../../src/server/conversationGraphChangeRoutes.js';

/**
 * Found on the real Studio + M5 removal test (2026-11-09): when the request
 * timeout had already answered 408 while a change was still saving, the route
 * wrote a second reply and logged ERR_HTTP_HEADERS_SENT. A late reply is now
 * dropped; the change itself is unaffected.
 */
describe('conversation-graph change route after the request timeout answered', () => {
  it('does not write a second reply', async () => {
    let release!: () => void; const saved = new Promise<void>((r) => { release = r; });
    const errors: unknown[] = [];
    const viewer = { principalKey: 'owner', grantVersion: 1 } as never;
    const app = express(); app.use(express.json());
    // Stand-in for the server's request timeout: answer 408, then let the save finish.
    app.use((_req, res, next) => { setTimeout(() => { res.status(408).json({ error: 'timeout' }); release(); }, 20); next(); });
    app.use(createConversationGraphChangeRouter({
      changes: { submit: async () => { await saved; return { status: 200, body: { ok: true } }; } } as never,
      resolveViewer: () => viewer,
    }));
    app.use((err: unknown, _req: express.Request, _res: express.Response, _next: express.NextFunction) => { errors.push(err); });
    const res = await request(app).post('/conversation-graph/changes').send({ requestId: 'r1', change: {} });
    expect(res.status).toBe(408);
    await new Promise((r) => setTimeout(r, 50));
    expect(errors).toEqual([]);
  });
  it('does nothing when the timeout answered before the route was reached', async () => {
    // Real Studio run (2026-11-09): a request queued behind a long readiness pass reached the
    // route after the 408 had gone out, and setting Cache-Control threw ERR_HTTP_HEADERS_SENT.
    const failures: unknown[] = []; const onRejection = (reason: unknown) => { failures.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      let submitted = 0; let reached!: () => void; const routeDone = new Promise<void>((r) => { reached = r; });
      const viewer = { principalKey: 'owner', grantVersion: 1 } as never;
      const app = express(); app.use(express.json());
      app.use((_req, res, next) => { res.status(408).json({ error: 'timeout' }); next(); res.on('finish', () => setTimeout(reached, 20)); });
      app.use(createConversationGraphChangeRouter({
        changes: { submit: async () => { submitted++; return { status: 200, body: { ok: true } }; } } as never,
        resolveViewer: () => viewer,
      }));
      const res = await request(app).post('/conversation-graph/changes').send({ requestId: 'r2', change: {} });
      expect(res.status).toBe(408);
      await routeDone; await new Promise((r) => setTimeout(r, 30));
      expect(failures).toEqual([]);
      expect(submitted).toBe(0);
    } finally { process.off('unhandledRejection', onRejection); }
  });
});
