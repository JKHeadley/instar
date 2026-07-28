/**
 * GET /attention?scope=pool — pool-wide attention aggregation (WS4.1,
 * MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.1). Read-side contract, both sides of
 * every boundary:
 *   - plain GET /attention stays back-compatible (items + count), self-tagged
 *     with machineId/machineNickname when the pool is wired;
 *   - scope=pool merges every reachable peer's items behind a REAL second HTTP
 *     server, tagging each with the peer's identity;
 *   - a dead/offline peer degrades to a pool.failed entry — never a 500;
 *   - P17 merge-point coalesce collapses same-key NORMAL items across machines
 *     into ONE row; HIGH/URGENT are NEVER coalesced;
 *   - the short-TTL cache reuses one fan-out within the window.
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

const PROJECT_NAME = 'attention-pool-scope-test';
let AUTH = '';

interface CtxOpts {
  items?: Array<Record<string, unknown>>;
  meshSelfId?: string | null;
  capacities?: Record<string, { nickname?: string; online?: boolean }>;
  peers?: Array<{ machineId: string; url: string }>;
  pool?: boolean;
}

function buildCtx(tmpDir: string, opts: CtxOpts = {}): RouteContext {
  return {
    config: { projectName: PROJECT_NAME, projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: AUTH } as never,
    telegram: {
      getAttentionItems: (status?: string) =>
        (opts.items ?? []).filter((i) => !status || i.status === status),
    } as never,
    meshSelfId: opts.meshSelfId ?? null,
    machinePoolRegistry: (opts.pool ?? true)
      ? ({ getCapacity: (id: string) => opts.capacities?.[id] ?? null, getCapacities: () => [] } as never)
      : null,
    resolvePeerUrls: opts.peers ? () => opts.peers! : null,
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

function item(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'a1', title: 'T', summary: 'S', category: 'health', priority: 'NORMAL',
    status: 'OPEN', createdAt: '2026-06-13T00:00:00Z', updatedAt: '2026-06-13T00:00:00Z',
    ...over,
  };
}

describe('GET /attention — pool-wide aggregation (WS4.1)', () => {
  let tmpDir: string;
  let peerServer: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-pool-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });
  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    if (peerServer) { await new Promise((r) => peerServer!.close(r)); peerServer = null; }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  async function listenPeer(items: Array<Record<string, unknown>>, meshSelfId: string): Promise<string> {
    const app = mount(tmpDir, { items, meshSelfId, capacities: { [meshSelfId]: { nickname: 'Mac Mini', online: true } } });
    peerServer = app.listen(0);
    await new Promise((r) => peerServer!.once('listening', r));
    const addr = peerServer!.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('plain GET /attention stays {items,count} and self-tags machine identity when wired', async () => {
    const app = mount(tmpDir, { items: [item({ id: 'x' })], meshSelfId: 'm_a', capacities: { m_a: { nickname: 'Laptop', online: true } } });
    const res = await request(app).get('/attention').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.items[0].machineId).toBe('m_a');
    expect(res.body.items[0].machineNickname).toBe('Laptop');
  });

  it('scope=pool merges a REAL peer\'s items, each tagged with the peer identity', async () => {
    const peerUrl = await listenPeer([item({ id: 'p1', title: 'peer-item', sourceContext: 'peer-src' })], 'm_b');
    const app = mount(tmpDir, {
      items: [item({ id: 'l1', title: 'local-item', sourceContext: 'local-src' })],
      meshSelfId: 'm_a', capacities: { m_a: { nickname: 'Laptop', online: true }, m_b: { nickname: 'Mac Mini', online: true } },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });
    const res = await request(app).get('/attention').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pool).toMatchObject({ enabled: true, selfMachineId: 'm_a', peersQueried: 1, peersOk: 1, failed: [] });
    const titles = res.body.items.map((i: { title: string }) => i.title).sort();
    expect(titles).toEqual(['local-item', 'peer-item']);
    const remote = res.body.items.find((i: { title: string }) => i.title === 'peer-item');
    expect(remote.machineId).toBe('m_b');
    expect(remote.machineNickname).toBe('Mac Mini');
    expect(remote.remote).toBe(true);
  });

  it('P17: same-key NORMAL items across machines coalesce into ONE row (machines listed)', async () => {
    // Both machines raised the SAME episode (same sourceContext).
    const peerUrl = await listenPeer([item({ id: 'p', sourceContext: 'guard-tripwire-X' })], 'm_b');
    const app = mount(tmpDir, {
      items: [item({ id: 'l', sourceContext: 'guard-tripwire-X' })],
      meshSelfId: 'm_a', capacities: { m_a: { online: true }, m_b: { nickname: 'Mac Mini', online: true } },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });
    const res = await request(app).get('/attention').query({ scope: 'pool' }).set(auth());
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].coalescedFrom).toEqual(['m_a', 'm_b']);
  });

  it('P17: HIGH/URGENT items are NEVER coalesced even on the same key', async () => {
    const peerUrl = await listenPeer([item({ id: 'p', priority: 'HIGH', sourceContext: 'crit-X' })], 'm_b');
    const app = mount(tmpDir, {
      items: [item({ id: 'l', priority: 'HIGH', sourceContext: 'crit-X' })],
      meshSelfId: 'm_a', capacities: { m_a: { online: true }, m_b: { online: true } },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });
    const res = await request(app).get('/attention').query({ scope: 'pool' }).set(auth());
    expect(res.body.items).toHaveLength(2);
  });

  it('an OFFLINE peer is skipped to a pool.failed entry without waiting (never a 500)', async () => {
    const app = mount(tmpDir, {
      items: [item({ id: 'l' })], meshSelfId: 'm_a',
      capacities: { m_a: { online: true }, m_off: { online: false } },
      peers: [{ machineId: 'm_off', url: 'http://127.0.0.1:1' }],
    });
    const res = await request(app).get('/attention').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed[0]).toMatchObject({ machineId: 'm_off', error: 'offline' });
  });

  it('an unreachable (unknown-state) peer degrades to failed, local items still answer', async () => {
    const app = mount(tmpDir, {
      items: [item({ id: 'l' })], meshSelfId: 'm_a', capacities: { m_a: { online: true } },
      peers: [{ machineId: 'm_dead', url: 'http://127.0.0.1:1' }],
    });
    const res = await request(app).get('/attention').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed[0].machineId).toBe('m_dead');
  });

  it('scope=pool with no peers answers local-only, enabled true', async () => {
    const app = mount(tmpDir, { items: [item({ id: 'l' })], meshSelfId: 'm_a', capacities: { m_a: { online: true } } });
    const res = await request(app).get('/attention').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pool).toMatchObject({ peersQueried: 0, peersOk: 0 });
  });
});
