/**
 * Integration: POST /pool/transfer refuses a Slack conversation in words, before planning or
 * proxying, and leaves its ownership untouched
 * (docs/specs/slack-conversations-stay-with-connection.md §2.2).
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';

function buildApp(owner: string | null) {
  const touched: string[] = [];
  const ctx = {
    config: { projectName: 't', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: 'tok', sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    sessionOwnershipRegistry: {
      ownerOf: (k: string) => { touched.push(`ownerOf ${k}`); return owner; },
      read: () => { touched.push('read'); return null; },
      cas: () => { touched.push('cas'); return { ok: true }; },
    },
    topicPinStore: { get: () => null },
    machinePoolRegistry: { getCapacities: () => [{ machineId: 'm_studio', nickname: 'Studio' }] },
    resolveRouterUrl: () => { touched.push('proxy'); return null; },
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return { app, touched };
}

describe('POST /pool/transfer — a Slack conversation stays with its connection', () => {
  for (const topic of ['C0ABC123', 'C0ABC123:1730000000.000100', 'slack:C0ABC123', 'slack:T0XYZ:C0ABC123']) {
    it(`${topic}: 409 in words, naming the machine; nothing planned, proxied or written`, async () => {
      const { app, touched } = buildApp('m_studio');
      const res = await request(app).post('/pool/transfer').send({ topic, to: 'Laptop' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, code: 'slack-stays-with-connection', error: 'This Slack conversation stays on Studio, which holds your Slack connection.' });
      expect(touched.filter((t) => t !== `ownerOf ${topic.replace(/^slack:(T[A-Z0-9]+:)?/, '')}`)).toEqual([]);
    });
  }
  it('with no owner on record, the words still say where it stays', async () => {
    const { app } = buildApp(null);
    const res = await request(app).post('/pool/transfer').send({ topic: 'C0ABC123', to: 'Laptop' });
    expect(res.body.error).toBe('This Slack conversation stays on the machine that holds your Slack connection.');
  });
});

describe('POST /pool/transfer — only Slack is refused here', () => {
  function bare() {
    const ctx = {
      config: { projectName: 't', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: 'tok', sessions: {}, scheduler: {} },
      sessionManager: { listRunningSessions: () => [] },
      state: { getJobState: () => null, getSession: () => null },
      startTime: new Date(),
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return app;
  }
  it('a Telegram topic or an app conversation passes the Slack check and reaches the pool check', async () => {
    for (const topic of ['13481', 'telegram:13481', 'app:0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f']) {
      const res = await request(bare()).post('/pool/transfer').send({ topic, to: 'Laptop' });
      expect(res.status, topic).toBe(503);
      expect(res.body.code, topic).not.toBe('slack-stays-with-connection');
    }
  });
  it('a Slack conversation is refused even where the pool is off', async () => {
    const res = await request(bare()).post('/pool/transfer').send({ topic: 'C0ABC123', to: 'Laptop' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slack-stays-with-connection');
  });
});
