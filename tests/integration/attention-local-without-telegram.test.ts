/**
 * An agent with no Telegram keeps an attention list on disk (LocalAttentionItems),
 * served by GET /attention, GET /attention/:id and PATCH /attention/:id. With no
 * Telegram and no local list the routes keep answering 503 as before.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { LocalAttentionItems } from '../../src/core/LocalAttentionItems.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function app(localAttention: LocalAttentionItems | null): express.Express {
  const a = express();
  a.use(express.json());
  const ctx: any = { config: { authToken: 'test', stateDir: '/tmp', port: 0 }, telegram: null, localAttention, meshSelfId: 'm-self' };
  a.use(createRoutes(ctx));
  return a;
}

describe('attention routes without Telegram', () => {
  it('serve, resolve and filter the local list', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-local-'));
    try {
      const store = new LocalAttentionItems(dir);
      store.raise({ id: 'agent:desktop-relock-failed:k', title: 'A Mac may still be unlocked', summary: 'Lock it, or open it to check.', priority: 'HIGH', category: 'security' });
      const a = app(store);

      const list = await request(a).get('/attention');
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ count: 1, surface: 'local' });
      expect(list.body.items[0]).toMatchObject({ id: 'agent:desktop-relock-failed:k', priority: 'HIGH', status: 'OPEN', machineId: 'm-self' });

      const one = await request(a).get('/attention/agent:desktop-relock-failed:k');
      expect(one.status).toBe(200);
      expect(one.body.title).toBe('A Mac may still be unlocked');
      expect((await request(a).get('/attention/unknown')).status).toBe(404);

      const done = await request(a).patch('/attention/agent:desktop-relock-failed:k').send({ status: 'resolved', resolution: 'locked it' });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ status: 'DONE', resolution: 'locked it' });
      expect((await request(a).get('/attention?status=open')).body.count).toBe(0);
      expect((await request(a).patch('/attention/unknown').send({ status: 'done' })).status).toBe(404);
      expect((await request(a).patch('/attention/agent:desktop-relock-failed:k').send({ status: 'bogus' })).status).toBe(400);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); }
  });

  it('answers 503 as before when there is neither Telegram nor a local list', async () => {
    const a = app(null);
    expect((await request(a).get('/attention')).status).toBe(503);
    expect((await request(a).get('/attention/x')).status).toBe(503);
    expect((await request(a).patch('/attention/x').send({ status: 'done' })).status).toBe(503);
  });
});
