/**
 * POST /attention/:id/remote-ack — durable operator-bound ack for an attention
 * item owned by ANOTHER machine (WS4.1 follow-up, CMT-1416). Full HTTP pipeline,
 * both sides of every decision boundary:
 *   - flag OFF ⇒ the route 503s, the PATCH precedence guard is inert (strict
 *     no-op — byte-for-byte today's behavior);
 *   - flag ON + owner REACHABLE ⇒ the ack is delivered immediately to the owner's
 *     PATCH /attention/:id (carrying X-Instar-Remote-Ack), no durable row left;
 *   - flag ON + owner UNREACHABLE ⇒ the intent is persisted and reported queued;
 *     a later drain (owner back) delivers it and clears the queue;
 *   - the receiver's precedence guard REJECTS a stale resolve against an item
 *     that has SINCE escalated to HIGH/URGENT (425), and the relayer drops the
 *     stale intent;
 *   - self-owned items are refused (use the plain PATCH).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'attention-remote-ack-test';
let AUTH = '';

interface FakeItem {
  id: string;
  priority: string;
  status: string;
}

interface CtxOpts {
  enabled?: boolean;
  meshSelfId?: string | null;
  items?: FakeItem[];
  machines?: Array<{ machineId: string; nickname?: string; lastKnownUrl?: string | null }>;
  operator?: { uid: string; names: string[] } | null;
  /** capture of the last updateAttentionStatus call on THIS ctx (receiver side). */
  updates?: Array<{ id: string; status: string }>;
}

function buildCtx(tmpDir: string, opts: CtxOpts = {}): RouteContext {
  const items = new Map<string, FakeItem>((opts.items ?? []).map((i) => [i.id, i]));
  const updates = opts.updates ?? [];
  return {
    config: {
      projectName: PROJECT_NAME,
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      port: 0,
      authToken: AUTH,
      multiMachine: { seamlessness: { ws41DurableAck: opts.enabled ?? false } },
    } as never,
    telegram: {
      getAttentionItem: (id: string) => items.get(id),
      getAttentionItems: () => Array.from(items.values()),
      updateAttentionStatus: async (id: string, status: string) => {
        const it = items.get(id);
        if (!it) return false;
        it.status = status;
        updates.push({ id, status });
        return true;
      },
    } as never,
    meshSelfId: opts.meshSelfId ?? 'm_self',
    machinePoolRegistry: { getCapacity: () => null, getCapacities: () => [] } as never,
    listPoolMachines: opts.machines ? () => opts.machines! : (() => []),
    topicOperatorStore: { asVerifiedOperator: () => opts.operator ?? null } as never,
    resolvePeerUrls: null,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
    sessionManager: null, scheduler: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
}

function mount(tmpDir: string, opts: CtxOpts = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(buildCtx(tmpDir, opts)));
  return app;
}

const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('POST /attention/:id/remote-ack — durable cross-machine ack (WS4.1)', () => {
  let tmpDir: string;
  let ownerServer: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rack-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });
  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    if (ownerServer) { await new Promise((r) => ownerServer!.close(r)); ownerServer = null; }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  /** A REAL owning-machine server with the given item(s). */
  async function listenOwner(items: FakeItem[], updates: Array<{ id: string; status: string }>): Promise<string> {
    const app = mount(tmpDir, { enabled: true, meshSelfId: 'm_owner', items, updates });
    ownerServer = app.listen(0);
    await new Promise((r) => ownerServer!.once('listening', r));
    const addr = ownerServer!.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('flag OFF ⇒ the route 503s (strict no-op)', async () => {
    const app = mount(tmpDir, { enabled: false });
    const res = await request(app).post('/attention/att-1/remote-ack').set(auth()).send({ machineId: 'm_owner', status: 'DONE' });
    expect(res.status).toBe(503);
  });

  it('flag OFF ⇒ a PATCH carrying X-Instar-Remote-Ack on a HIGH item still applies (guard inert)', async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const app = mount(tmpDir, { enabled: false, items: [{ id: 'h', priority: 'HIGH', status: 'OPEN' }], updates });
    const res = await request(app).patch('/attention/h').set(auth()).set('X-Instar-Remote-Ack', 'op').send({ status: 'DONE' });
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ id: 'h', status: 'DONE' }]); // guard did NOT block — off
  });

  it('flag ON + owner REACHABLE ⇒ ack delivered immediately, no durable row', async () => {
    const ownerUpdates: Array<{ id: string; status: string }> = [];
    const ownerUrl = await listenOwner([{ id: 'att-1', priority: 'NORMAL', status: 'OPEN' }], ownerUpdates);
    const app = mount(tmpDir, {
      enabled: true, meshSelfId: 'm_self',
      machines: [{ machineId: 'm_owner', lastKnownUrl: ownerUrl, nickname: 'Mac Mini' }],
      operator: { uid: 'tg:42', names: ['Justin'] },
    });
    const res = await request(app).post('/attention/att-1/remote-ack').set(auth()).send({ machineId: 'm_owner', status: 'DONE', topicId: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivered: true });
    expect(ownerUpdates).toEqual([{ id: 'att-1', status: 'DONE' }]); // it actually landed on the owner
    // No durable row persisted (immediate success).
    const pending = await request(app).get('/attention/_remote-ack/pending').set(auth());
    expect(pending.body.count).toBe(0);
  });

  it('flag ON + owner UNREACHABLE ⇒ intent persisted + queued; later drain delivers when owner is back', async () => {
    // Owner not started yet → unreachable.
    const machines = [{ machineId: 'm_owner', lastKnownUrl: 'http://127.0.0.1:1', nickname: 'Mac Mini' }];
    const app = mount(tmpDir, { enabled: true, meshSelfId: 'm_self', machines });
    const res = await request(app).post('/attention/att-9/remote-ack').set(auth()).send({ machineId: 'm_owner', status: 'DONE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, queued: true, pending: 1 });
    const pending = await request(app).get('/attention/_remote-ack/pending').set(auth());
    expect(pending.body.count).toBe(1);
    expect(pending.body.pending[0]).toMatchObject({ itemId: 'att-9', targetMachineId: 'm_owner', status: 'DONE' });

    // Owner comes back: a real server + a drain delivers and clears the queue.
    const ownerUpdates: Array<{ id: string; status: string }> = [];
    const ownerUrl = await listenOwner([{ id: 'att-9', priority: 'NORMAL', status: 'OPEN' }], ownerUpdates);
    // Rebuild the relayer ctx pointing at the now-live owner (same stateDir ⇒ same durable queue).
    const app2 = mount(tmpDir, {
      enabled: true, meshSelfId: 'm_self',
      machines: [{ machineId: 'm_owner', lastKnownUrl: ownerUrl, nickname: 'Mac Mini' }],
    });
    const drain = await request(app2).post('/attention/_remote-ack/drain').set(auth());
    expect(drain.body).toMatchObject({ ok: true, delivered: 1, pending: 0 });
    expect(ownerUpdates).toEqual([{ id: 'att-9', status: 'DONE' }]);
  });

  it('receiver precedence guard: a stale resolve against a SINCE-escalated HIGH item is rejected (425) and the intent is dropped', async () => {
    // Owner now holds the item at HIGH (it escalated after the ack was issued).
    const ownerUpdates: Array<{ id: string; status: string }> = [];
    const ownerUrl = await listenOwner([{ id: 'att-x', priority: 'HIGH', status: 'OPEN' }], ownerUpdates);
    const app = mount(tmpDir, {
      enabled: true, meshSelfId: 'm_self',
      machines: [{ machineId: 'm_owner', lastKnownUrl: ownerUrl, nickname: 'Mac Mini' }],
    });
    const res = await request(app).post('/attention/att-x/remote-ack').set(auth()).send({ machineId: 'm_owner', status: 'DONE' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, staleSuperseded: true });
    expect(ownerUpdates).toEqual([]); // the owner did NOT apply the stale resolve
    // The relayer left no durable retry (terminal — can never succeed).
    const pending = await request(app).get('/attention/_remote-ack/pending').set(auth());
    expect(pending.body.count).toBe(0);
  });

  it('receiver precedence guard (direct PATCH): X-Instar-Remote-Ack DONE on a HIGH item ⇒ 425, not applied', async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const app = mount(tmpDir, { enabled: true, items: [{ id: 'h', priority: 'HIGH', status: 'OPEN' }], updates });
    const res = await request(app).patch('/attention/h').set(auth()).set('X-Instar-Remote-Ack', 'op').send({ status: 'DONE' });
    expect(res.status).toBe(425);
    expect(res.body.error).toBe('stale-superseded');
    expect(updates).toEqual([]); // current state wins
  });

  it('self-owned item is refused (use the plain PATCH)', async () => {
    const app = mount(tmpDir, { enabled: true, meshSelfId: 'm_self', machines: [] });
    const res = await request(app).post('/attention/att-1/remote-ack').set(auth()).send({ machineId: 'm_self', status: 'DONE' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owned by this machine/);
  });

  it('missing machineId ⇒ 400', async () => {
    const app = mount(tmpDir, { enabled: true });
    const res = await request(app).post('/attention/att-1/remote-ack').set(auth()).send({ status: 'DONE' });
    expect(res.status).toBe(400);
  });
});
