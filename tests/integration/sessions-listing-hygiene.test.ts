/**
 * GET /sessions — session-listing hygiene (CMT-1936).
 *
 * The 2026-07-09 production shape: the Mac Mini's GET /sessions returned 53
 * rows of which 52 were finished background runs (mentor-stage-a / job-*),
 * read by the operator as "duplicate sessions running across both machines".
 *
 * Route-level contract, both sides of every boundary:
 *   - the DEFAULT listing is ACTIVE sessions only (starting/running);
 *   - `?include=all` returns the full registry (finished runs included);
 *   - `?status=<any valid>` keeps its exact pre-change semantics;
 *   - scope=pool: the fan-out forwards the caller's visibility opt-in to
 *     peers AND defensively filters a LEGACY peer's full-registry answer;
 *   - scope=pool flags GENUINE cross-machine duplicates (the SAME
 *     conversation live on >=2 machines) via pool.duplicateTopics +
 *     per-row duplicateTopic — while the same recurring job on each machine
 *     (benign, by design) is never flagged;
 *   - pool.machines[].sessionCount counts the requested view (active-only
 *     by default), so 50 finished records no longer inflate a machine's count.
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

const PROJECT_NAME = 'sessions-listing-hygiene-test';
let AUTH = '';

interface CtxOpts {
  sessions?: Array<Record<string, unknown>>;
  meshSelfId?: string | null;
  nicknames?: Record<string, string>;
  peers?: Array<{ machineId: string; url: string }>;
  /** The /guards?scope=pool accounting roster (every registered machine). */
  knownMachines?: Array<{ machineId: string; nickname?: string }>;
  /** Map tmuxSession → telegram topic id (drives platform/platformId enrichment). */
  topicBySession?: Record<string, number>;
}

function buildCtx(tmpDir: string, opts: CtxOpts = {}): RouteContext {
  const caps: Record<string, { nickname?: string }> = {};
  for (const [id, nick] of Object.entries(opts.nicknames ?? {})) caps[id] = { nickname: nick };
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
      listSessions: (filter?: { status?: string }) => {
        const all = opts.sessions ?? [];
        return filter?.status ? all.filter((s) => s.status === filter.status) : all;
      },
    } as never,
    sessionManager: null,
    meshSelfId: opts.meshSelfId ?? null,
    machinePoolRegistry: {
      getCapacity: (id: string) => caps[id] ?? null,
      getCapacities: () => Object.entries(caps).map(([machineId, c]) => ({ machineId, ...c })),
    } as never,
    resolvePeerUrls: opts.peers ? () => opts.peers! : null,
    listPoolMachines: opts.knownMachines ? () => opts.knownMachines! : null,
    telegram: opts.topicBySession
      ? ({
          getTopicForSession: (tmux: string) => opts.topicBySession![tmux],
          getTopicName: () => undefined,
        } as never)
      : null,
    scheduler: null, relationships: null, feedback: null, dispatches: null,
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

let seq = 0;
function sess(over: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return {
    id: `sess-${seq}`,
    name: `s-${seq}`,
    status: 'running',
    tmuxSession: `instar-s-${seq}`,
    startedAt: new Date().toISOString(),
    ...over,
  };
}

describe('GET /sessions — listing hygiene', () => {
  let tmpDir: string;
  let peerServer: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-listing-hygiene-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });

  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    if (peerServer) { await new Promise((r) => peerServer!.close(r)); peerServer = null; }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  /** A LEGACY peer: answers GET /sessions with its FULL registry regardless of
   *  query — the pre-change plain-route behavior every already-deployed
   *  machine still has during a mixed-version rollout window. */
  async function listenLegacyPeer(rows: Array<Record<string, unknown>>): Promise<string> {
    const app = express();
    app.get('/sessions', (_req, res) => { res.json(rows); });
    peerServer = app.listen(0);
    await new Promise((r) => peerServer!.once('listening', r));
    const addr = peerServer!.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  const REGISTRY = () => [
    sess({ status: 'running', name: 'live-task' }),
    sess({ status: 'starting', name: 'booting-task' }),
    sess({ status: 'completed', name: 'mentor-stage-a-1', launchLane: 'headless' }),
    sess({ status: 'completed', name: 'job-health-check-x', jobSlug: 'health-check' }),
    sess({ status: 'failed', name: 'failed-task' }),
    sess({ status: 'killed', name: 'killed-task' }),
  ];

  it('DEFAULT: returns ACTIVE sessions only (finished runs excluded)', async () => {
    const app = mount(tmpDir, { sessions: REGISTRY() });
    const res = await request(app).get('/sessions').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['booting-task', 'live-task']);
  });

  it('?include=all returns the FULL registry (finished runs included)', async () => {
    const app = mount(tmpDir, { sessions: REGISTRY() });
    const res = await request(app).get('/sessions').query({ include: 'all' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    const statuses = new Set(res.body.map((s: { status: string }) => s.status));
    expect(statuses).toEqual(new Set(['running', 'starting', 'completed', 'failed', 'killed']));
  });

  it('?status=<terminal> keeps its exact pre-change semantics', async () => {
    const app = mount(tmpDir, { sessions: REGISTRY() });
    const completed = await request(app).get('/sessions').query({ status: 'completed' }).set(auth());
    expect(completed.status).toBe(200);
    expect(completed.body.map((s: { name: string }) => s.name).sort())
      .toEqual(['job-health-check-x', 'mentor-stage-a-1']);
    const failed = await request(app).get('/sessions').query({ status: 'failed' }).set(auth());
    expect(failed.body.map((s: { name: string }) => s.name)).toEqual(['failed-task']);
  });

  it('an INVALID ?status falls back to the default active-only view', async () => {
    const app = mount(tmpDir, { sessions: REGISTRY() });
    const res = await request(app).get('/sessions').query({ status: 'bogus' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.map((s: { name: string }) => s.name).sort()).toEqual(['booting-task', 'live-task']);
  });

  describe('scope=pool', () => {
    it('defensively filters a LEGACY peer full-registry answer to the active view', async () => {
      const peerUrl = await listenLegacyPeer([
        sess({ status: 'running', name: 'peer-live' }),
        sess({ status: 'completed', name: 'peer-finished-1' }),
        sess({ status: 'completed', name: 'peer-finished-2' }),
        sess({ status: 'killed', name: 'peer-killed' }),
      ]);
      const app = mount(tmpDir, {
        sessions: [sess({ status: 'running', name: 'local-live' }), sess({ status: 'completed', name: 'local-finished' })],
        meshSelfId: 'm_a',
        nicknames: { m_a: 'Laptop', m_b: 'Mac Mini' },
        peers: [{ machineId: 'm_b', url: peerUrl }],
        knownMachines: [{ machineId: 'm_b', nickname: 'Mac Mini' }],
      });

      const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
      expect(res.status).toBe(200);
      const names = res.body.sessions.map((s: { name: string }) => s.name).sort();
      expect(names).toEqual(['local-live', 'peer-live']);
      // The per-machine counts reflect the ACTIVE view — a machine with 50
      // finished records is honestly "1 session", not "51".
      const byId = Object.fromEntries(res.body.pool.machines.map(
        (m: { machineId: string; sessionCount: number }) => [m.machineId, m.sessionCount],
      ));
      expect(byId.m_a).toBe(1);
      expect(byId.m_b).toBe(1);
    });

    it('forwards ?include=all to the merge (legacy peer finished rows included)', async () => {
      const peerUrl = await listenLegacyPeer([
        sess({ status: 'running', name: 'peer-live' }),
        sess({ status: 'completed', name: 'peer-finished' }),
      ]);
      const app = mount(tmpDir, {
        sessions: [sess({ status: 'completed', name: 'local-finished' })],
        meshSelfId: 'm_a',
        peers: [{ machineId: 'm_b', url: peerUrl }],
      });

      const res = await request(app).get('/sessions').query({ scope: 'pool', include: 'all' }).set(auth());
      expect(res.status).toBe(200);
      const names = res.body.sessions.map((s: { name: string }) => s.name).sort();
      expect(names).toEqual(['local-finished', 'peer-finished', 'peer-live']);
    });

    it('flags a GENUINE cross-machine duplicate — the SAME conversation LIVE on two machines', async () => {
      const peerUrl = await listenLegacyPeer([
        sess({ status: 'running', name: 'peer-topic-999', platform: 'telegram', platformId: 999 }),
      ]);
      const localLive = sess({ status: 'running', name: 'local-topic-999', tmuxSession: 'instar-topic-999' });
      const app = mount(tmpDir, {
        sessions: [localLive],
        meshSelfId: 'm_a',
        nicknames: { m_a: 'Laptop', m_b: 'Mac Mini' },
        peers: [{ machineId: 'm_b', url: peerUrl }],
        topicBySession: { 'instar-topic-999': 999 },
      });

      const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.pool.duplicateTopics).toHaveLength(1);
      const dup = res.body.pool.duplicateTopics[0];
      expect(dup.platform).toBe('telegram');
      expect(String(dup.platformId)).toBe('999');
      expect(dup.machineIds.sort()).toEqual(['m_a', 'm_b']);
      expect(dup.sessions.sort()).toEqual(['local-topic-999', 'peer-topic-999']);
      // Every flagged row carries the loud per-row marker.
      const flagged = res.body.sessions.filter((s: { duplicateTopic?: boolean }) => s.duplicateTopic === true);
      expect(flagged.map((s: { name: string }) => s.name).sort()).toEqual(['local-topic-999', 'peer-topic-999']);
    });

    it('does NOT flag the benign shapes: same recurring job per machine; finished twin of a live session', async () => {
      const peerUrl = await listenLegacyPeer([
        // Same job name as local — each machine's OWN scheduled copy (by design).
        sess({ status: 'running', name: 'job-health-check', platform: 'headless' }),
        // A FINISHED record of the same conversation the local machine now runs
        // live — the normal topic-move case, not an incoherency.
        sess({ status: 'completed', name: 'peer-topic-999-old', platform: 'telegram', platformId: 999 }),
      ]);
      const app = mount(tmpDir, {
        sessions: [
          sess({ status: 'running', name: 'job-health-check' }),
          sess({ status: 'running', name: 'local-topic-999', tmuxSession: 'instar-topic-999' }),
        ],
        meshSelfId: 'm_a',
        peers: [{ machineId: 'm_b', url: peerUrl }],
        topicBySession: { 'instar-topic-999': 999 },
      });

      // include=all so the finished twin is even PRESENT in the merged list —
      // duplicate detection must still ignore it (only LIVE rows count).
      const res = await request(app).get('/sessions').query({ scope: 'pool', include: 'all' }).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.pool.duplicateTopics).toEqual([]);
      expect(res.body.sessions.every((s: { duplicateTopic?: boolean }) => s.duplicateTopic !== true)).toBe(true);
    });
  });
});
