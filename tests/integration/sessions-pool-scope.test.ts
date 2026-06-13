/**
 * GET /sessions?scope=pool — pool-wide session aggregation (operator
 * requirement, 2026-06-05 topic 13481: every session must show on the
 * dashboard with the machine it runs on).
 *
 * Route-level contract, both sides of every boundary:
 *   - plain GET /sessions stays a back-compatible ARRAY, self-tagged with
 *     machineId/machineNickname when the pool is wired (omitted when not);
 *   - scope=pool merges every reachable peer's sessions, tagging each with the
 *     peer's identity, behind a REAL second HTTP server;
 *   - a dead peer degrades to a pool.failed entry — never a 500;
 *   - no pool wiring → scope=pool still answers (local-only, enabled:false).
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

const PROJECT_NAME = 'sessions-pool-scope-test';
let AUTH = '';

/** A machine's registry capacity for the WS4.2 empty-state classifier. */
interface CapacityOpt {
  nickname?: string;
  online?: boolean;
  routerReceivedAt?: string;
  selfReportedLastSeen?: string;
}

interface CtxOpts {
  sessions?: Array<Record<string, unknown>>;
  meshSelfId?: string | null;
  nicknames?: Record<string, string>;
  peers?: Array<{ machineId: string; url: string }>;
  pool?: boolean;
  /** WS4.2: full per-machine capacity (online/lastSeen) keyed by machineId. */
  capacities?: Record<string, CapacityOpt>;
  /** WS4.2: the /guards?scope=pool accounting roster (every registered machine). */
  knownMachines?: Array<{ machineId: string; nickname?: string; lastKnownUrl?: string | null }>;
}

function buildCtx(tmpDir: string, opts: CtxOpts = {}): RouteContext {
  // Merge legacy `nicknames` into a capacity map so older callers keep working
  // while new callers express full capacity (online/lastSeen).
  const caps: Record<string, CapacityOpt> = { ...(opts.capacities ?? {}) };
  for (const [id, nick] of Object.entries(opts.nicknames ?? {})) {
    caps[id] = { nickname: nick, ...(caps[id] ?? {}) };
  }
  return {
    config: {
      projectName: PROJECT_NAME,
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      port: 0,
      authToken: AUTH,
    } as never,
    state: {
      getJobState: () => null,
      getSession: () => null,
      listSessions: () => opts.sessions ?? [],
    } as never,
    sessionManager: null,
    meshSelfId: opts.meshSelfId ?? null,
    machinePoolRegistry: (opts.pool ?? true)
      ? ({ getCapacity: (id: string) => caps[id] ?? null, getCapacities: () => Object.entries(caps).map(([machineId, c]) => ({ machineId, ...c })) } as never)
      : null,
    resolvePeerUrls: opts.peers ? () => opts.peers! : null,
    listPoolMachines: opts.knownMachines ? () => opts.knownMachines! : null,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
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

const LOCAL_SESSION = {
  id: 'sess-local-1', name: 'local-task', status: 'running',
  tmuxSession: 'instar-local-task', startedAt: new Date().toISOString(),
};
const PEER_SESSION = {
  id: 'sess-peer-1', name: 'peer-task', status: 'running',
  tmuxSession: 'instar-peer-task', startedAt: new Date().toISOString(),
};

describe('GET /sessions — pool-wide aggregation', () => {
  let tmpDir: string;
  let peerServer: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pool-scope-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });

  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    if (peerServer) { await new Promise((r) => peerServer!.close(r)); peerServer = null; }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  /** Boot a REAL second routes app on a live port — the peer machine. */
  async function listenPeer(sessions: Array<Record<string, unknown>>, meshSelfId: string): Promise<string> {
    const app = mount(tmpDir, { sessions, meshSelfId, nicknames: { [meshSelfId]: 'Mac Mini' } });
    peerServer = app.listen(0);
    await new Promise((r) => peerServer!.once('listening', r));
    const addr = peerServer!.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('plain GET /sessions stays an ARRAY and self-tags machine identity when the pool is wired', async () => {
    const app = mount(tmpDir, { sessions: [LOCAL_SESSION], meshSelfId: 'm_a', nicknames: { m_a: 'Laptop' } });
    const res = await request(app).get('/sessions').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].machineId).toBe('m_a');
    expect(res.body[0].machineNickname).toBe('Laptop');
  });

  it('plain GET /sessions omits machine fields on a single-machine install (no pool)', async () => {
    const app = mount(tmpDir, { sessions: [LOCAL_SESSION], meshSelfId: null, pool: false });
    const res = await request(app).get('/sessions').set(auth());
    expect(res.status).toBe(200);
    expect(res.body[0].machineId).toBeUndefined();
    expect(res.body[0].machineNickname).toBeUndefined();
  });

  it('scope=pool merges a REAL peer server\'s sessions, each tagged with the peer\'s identity', async () => {
    const peerUrl = await listenPeer([PEER_SESSION], 'm_b');
    const app = mount(tmpDir, {
      sessions: [LOCAL_SESSION], meshSelfId: 'm_a',
      nicknames: { m_a: 'Laptop', m_b: 'Mac Mini' },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });

    const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pool).toMatchObject({
      enabled: true, selfMachineId: 'm_a', selfMachineNickname: 'Laptop',
      peersQueried: 1, peersOk: 1, failed: [],
    });
    const names = res.body.sessions.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['local-task', 'peer-task']);
    const remote = res.body.sessions.find((s: { name: string }) => s.name === 'peer-task');
    expect(remote.remote).toBe(true);
    expect(remote.machineId).toBe('m_b');
    expect(remote.machineNickname).toBe('Mac Mini');
    const local = res.body.sessions.find((s: { name: string }) => s.name === 'local-task');
    expect(local.remote).toBeUndefined();
    expect(local.machineNickname).toBe('Laptop');
  });

  it('a dead peer degrades to pool.failed — local sessions still answer, never a 500', async () => {
    const app = mount(tmpDir, {
      sessions: [LOCAL_SESSION], meshSelfId: 'm_a', nicknames: { m_a: 'Laptop' },
      peers: [{ machineId: 'm_dead', url: 'http://127.0.0.1:1' }],
    });

    const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].name).toBe('local-task');
    expect(res.body.pool.peersQueried).toBe(1);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed).toHaveLength(1);
    expect(res.body.pool.failed[0].machineId).toBe('m_dead');
  });

  it('scope=pool on a single-machine install answers local-only with enabled:false', async () => {
    const app = mount(tmpDir, { sessions: [LOCAL_SESSION], meshSelfId: null, pool: false });
    const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pool.enabled).toBe(false);
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.sessions).toHaveLength(1);
  });

  // ── WS4.2 (F7): explicit per-machine empty-state ────────────────────────
  describe('per-machine empty-state (WS4.2, F7)', () => {
    const recent = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

    /** A REAL second peer that returns ZERO sessions (idle but healthy). */
    async function listenIdlePeer(meshSelfId: string): Promise<string> {
      const app = mount(tmpDir, { sessions: [], meshSelfId, nicknames: { [meshSelfId]: 'Mac Mini' } });
      peerServer = app.listen(0);
      await new Promise((r) => peerServer!.once('listening', r));
      const addr = peerServer!.address() as { port: number };
      return `http://127.0.0.1:${addr.port}`;
    }

    it("an ONLINE peer with zero sessions → 'online — no active sessions'", async () => {
      const peerUrl = await listenIdlePeer('m_b');
      const app = mount(tmpDir, {
        sessions: [LOCAL_SESSION], meshSelfId: 'm_a',
        peers: [{ machineId: 'm_b', url: peerUrl }],
        capacities: { m_a: { nickname: 'Laptop' }, m_b: { nickname: 'Mac Mini', online: true, routerReceivedAt: recent(5_000) } },
        knownMachines: [
          { machineId: 'm_a', nickname: 'Laptop', lastKnownUrl: 'http://127.0.0.1:9' },
          { machineId: 'm_b', nickname: 'Mac Mini', lastKnownUrl: peerUrl },
        ],
      });

      const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
      expect(res.status).toBe(200);
      const mb = res.body.pool.machines.find((m: { machineId: string }) => m.machineId === 'm_b');
      expect(mb.sessionCount).toBe(0);
      expect(mb.emptyState.kind).toBe('online');
      expect(mb.emptyState.text).toBe('online — no active sessions');
      // The busy local machine gets NO empty-state (its session names it).
      const ma = res.body.pool.machines.find((m: { machineId: string }) => m.machineId === 'm_a');
      expect(ma.sessionCount).toBe(1);
      expect(ma.emptyState).toBeUndefined();
    });

    it("an OFFLINE peer (registry not-online, no URL) → 'offline since <t>'", async () => {
      const app = mount(tmpDir, {
        sessions: [LOCAL_SESSION], meshSelfId: 'm_a',
        // No live peer URL → no fan-out attempt; the registry says offline.
        capacities: {
          m_a: { nickname: 'Laptop' },
          m_dark: { nickname: 'Studio', online: false, routerReceivedAt: recent(2 * 60 * 60 * 1000) },
        },
        knownMachines: [
          { machineId: 'm_a', nickname: 'Laptop' },
          { machineId: 'm_dark', nickname: 'Studio', lastKnownUrl: null },
        ],
      });

      const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
      expect(res.status).toBe(200);
      const dark = res.body.pool.machines.find((m: { machineId: string }) => m.machineId === 'm_dark');
      expect(dark.sessionCount).toBe(0);
      expect(dark.emptyState.kind).toBe('offline');
      expect(dark.emptyState.text).toMatch(/^offline since /);
    });

    it("an UNREACHABLE peer (registry online, live fetch fails) → 'unreachable (last seen <t>)'", async () => {
      const app = mount(tmpDir, {
        sessions: [LOCAL_SESSION], meshSelfId: 'm_a',
        // The registry thinks m_lost is online and resolvePeerUrls yields a URL —
        // but the URL is a dead port, so the live fetch fails: surprise silence.
        peers: [{ machineId: 'm_lost', url: 'http://127.0.0.1:1' }],
        capacities: {
          m_a: { nickname: 'Laptop' },
          m_lost: { nickname: 'Mac Mini', online: true, routerReceivedAt: recent(20_000) },
        },
        knownMachines: [
          { machineId: 'm_a', nickname: 'Laptop' },
          { machineId: 'm_lost', nickname: 'Mac Mini', lastKnownUrl: 'http://127.0.0.1:1' },
        ],
      });

      const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
      expect(res.status).toBe(200);
      const lost = res.body.pool.machines.find((m: { machineId: string }) => m.machineId === 'm_lost');
      expect(lost.sessionCount).toBe(0);
      expect(lost.emptyState.kind).toBe('unreachable');
      expect(lost.emptyState.text).toMatch(/^unreachable \(last seen /);
      // Still degrades to a named pool.failed entry (back-compat) — never a 500.
      expect(res.body.pool.failed.some((f: { machineId: string }) => f.machineId === 'm_lost')).toBe(true);
    });

    it('the self (serving) machine, when idle, reads online — no active sessions', async () => {
      const app = mount(tmpDir, {
        sessions: [], meshSelfId: 'm_a',
        capacities: { m_a: { nickname: 'Laptop', online: true, routerReceivedAt: recent(1_000) } },
        knownMachines: [{ machineId: 'm_a', nickname: 'Laptop', lastKnownUrl: 'http://127.0.0.1:9' }],
      });
      const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
      expect(res.status).toBe(200);
      const self = res.body.pool.machines.find((m: { machineId: string }) => m.machineId === 'm_a');
      expect(self.isSelf).toBe(true);
      expect(self.emptyState.kind).toBe('online');
    });
  });
});
