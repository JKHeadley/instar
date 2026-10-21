/**
 * E2E lifecycle — the Machine choice in the dashboard New Session box
 * (docs/specs/dashboard-new-session-machine-choice.md §5, Tier 3).
 *
 * Two REAL AgentServers — a holder ("studio") and a target ("laptop", listening
 * on a real port so the step-0 pre-flight is real HTTP). They share ONE
 * authoritative SessionOwnershipRegistry (single-router topology, the parent
 * e2e's named fallback for the missing in-process router harness). The holder's
 * `startTopicOnMachine` is the REAL core over that registry; its deliver hop
 * stands in for the signed mesh by invoking the target's REAL owner-side runner
 * (`createDashboardCreateStartRunner`, the exact factory server.ts wires) and
 * answering the DeliverMessageHandler's `queued` ack. The target's spawn records
 * a Session, so the done-bar is read from the TARGET's GET /sessions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { SpawningTopicsRegistry } from '../../src/core/SpawningTopicsRegistry.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import {
  NewTopicDefaultStore,
  createSpawnForTopic,
  evaluateSessionPoolLocalClaim,
  seedTopicProfileAtCreation,
} from '../../src/core/dashboardTopicProfile.js';
import {
  startTopicOnMachine,
  createDashboardCreateStartRunner,
  parseDashboardCreatePayload,
  type DashboardCreateStart,
} from '../../src/core/dashboardMachineChoice.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

const AUTH = 'test-dash-machine-choice-e2e';
const auth = { Authorization: `Bearer ${AUTH}` };

let tmpRoot: string;
let nextTopic = 8000;
let listening: Server | null = null;

interface Machine {
  server: AgentServer;
  app: ReturnType<AgentServer['getApp']>;
  stateDir: string;
  store: TopicProfileStore;
  spawned: number[];
  notices: Array<{ topicId: number; text: string }>;
  runner: (topicId: number, start: DashboardCreateStart) => Promise<void>;
  pins: TopicPlacementPinStore;
}

type PoolOpts = {
  self: string;
  registry: SessionOwnershipRegistry;
  peers: () => Array<{ machineId: string; url: string }>;
  deliverTo: (machineId: string) => Machine | null;
};

function boot(name: string, bins: Record<string, string | null>, pool?: PoolOpts): Machine {
  const stateDir = path.join(tmpRoot, name, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  // ONE agent on two machines: the same agent id (and token) on both, as in the
  // pool; the per-machine identity is the machineId, never the agent name.
  const config = { projectName: 'echo', agentName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: AUTH } as InstarConfig;
  const store = new TopicProfileStore({ stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'), isDryRun: () => false });
  const resolver = new TopicProfileResolver({
    store,
    defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}),
    configProfileDefaults: () => ({}),
    frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined,
    localModelBinding: () => null,
    frameworkBinaryPath: (fw) => (fw in bins ? bins[fw] : null),
  });
  const surface = new TopicProfileWriteSurface({
    store, resolver, regime: () => ({ enabled: true, dryRun: false }),
    boundOperator: () => null, localModelBinding: () => null,
    legacyFrameworkRespawn: async () => ({ respawned: false }),
    disclose: async () => {}, audit: () => 'seq',
  });
  const state = new StateManager(stateDir);
  const topicToSession = new Map<number, string>();
  const m = { stateDir, store, spawned: [] as number[], notices: [] as Machine['notices'] } as Machine;
  m.pins = new TopicPlacementPinStore({ filePath: path.join(stateDir, 'state', 'topic-pins.json') });
  const telegram = {
    findOrCreateForumTopic: async (topicName: string) => ({ topicId: ++nextTopic, name: topicName, reused: false }),
    getSessionForTopic: (t: number) => topicToSession.get(t) ?? null,
    getTopicForSession: (s: string) => [...topicToSession.entries()].find(([, v]) => v === s)?.[0] ?? null,
    getTopicName: () => null,
    registerTopicSession: (t: number, s: string) => { topicToSession.set(t, s); },
    sendToTopic: async (topicId: number, text: string) => { m.notices.push({ topicId, text }); return {}; },
  };
  const guard = new SpawningTopicsRegistry();
  const spawn = async (topicId: number, topicName: string): Promise<string> => {
    const p = resolver.resolve(topicId);
    const tmuxSession = `${name}-topic-${topicId}`;
    state.saveSession({
      id: `s-${topicId}`, name: topicName, status: 'running', tmuxSession,
      startedAt: new Date().toISOString(), framework: p.framework, ...(p.model ? { model: p.model } : {}),
    } as Session);
    m.spawned.push(topicId);
    return tmuxSession;
  };
  const spawnForTopic = createSpawnForTopic({ guard: () => guard, telegram: () => telegram, spawn });
  const choiceDeps = {
    enabledFrameworks: () => undefined,
    doorAdmissibility: (fw: Parameters<TopicProfileResolver['doorAdmissibility']>[0]) => resolver.doorAdmissibility(fw),
  };
  m.runner = createDashboardCreateStartRunner({
    telegramReady: () => true,
    getSessionForTopic: (t) => telegram.getSessionForTopic(t),
    isSessionAlive: () => true,
    topicName: () => null,
    seedDeps: () => ({ ...choiceDeps, store, regime: () => surface.currentRegime(), audit: () => {}, disclose: async () => undefined }),
    seed: seedTopicProfileAtCreation,
    spawnForTopic: () => spawnForTopic,
    notice: (t, text) => { m.notices.push({ topicId: t, text }); },
    audit: () => {},
    selfLabel: () => (name === 'laptop' ? 'Laptop' : 'Mac Studio'),
  });
  let n = 0;
  const caps = [
    { machineId: 'studio', nickname: 'Mac Studio', online: true, clockSkewStatus: 'ok', seamlessnessFlags: { dashboardCreateReceive: true } },
    { machineId: 'laptop', nickname: 'Laptop', online: true, clockSkewStatus: 'ok', seamlessnessFlags: { dashboardCreateReceive: true } },
  ];
  m.server = new AgentServer({
    config,
    sessionManager: createMockSessionManager() as never,
    state,
    telegram: telegram as never,
    ...(pool ? {
      meshSelfId: pool.self,
      machinePoolRegistry: { getCapacities: () => caps, getCapacity: (id: string) => caps.find((c) => c.machineId === id) ?? null },
      topicPinStore: m.pins,
      replicatedRecordEmitter: { emit: () => {} },
      resolvePeerUrls: pool.peers,
      sessionOwnershipRegistry: pool.registry,
    } : {}),
    topicProfile: {
      store, resolver, surface,
      confirmSlots: new ProfileConfirmSlots({ ttlMs: () => 300_000 }),
      newTopicDefault: new NewTopicDefaultStore(stateDir),
      audit: () => {},
      discloseCreationSeed: async (key: string, text: string) => { m.notices.push({ topicId: Number(key), text }); },
      spawnForTopic,
      ...(pool ? {
        sessionPoolLocalClaim: () => evaluateSessionPoolLocalClaim({
          routerLive: () => true, replicationOn: true, holdsLease: () => pool.self === 'studio',
          holder: () => ({ machineId: 'studio', nickname: 'Mac Studio' }),
          ops: {
            place: () => ({ ok: true }), confirm: () => true, release: () => true,
          },
        }),
        pinReplicationLive: () => true,
        startTopicOnMachine: (key: string, target: string, start: DashboardCreateStart, pin?: () => Promise<boolean> | boolean) => startTopicOnMachine({
          readOwnership: (k) => {
            const r = pool.registry.read(k);
            return r ? { status: r.status, ownerMachineId: r.ownerMachineId ?? null, ownershipEpoch: r.ownershipEpoch } : null;
          },
          cas: (k, action) => {
            const r = pool.registry.cas(action, { sessionKey: k, sender: pool.self, nonce: `${pool.self}:dmc:${++n}` });
            return { ok: r.ok, epoch: pool.registry.read(k)?.ownershipEpoch ?? 0 };
          },
          // The signed-mesh stand-in: the target's DeliverMessageHandler accepts
          // a first-seen message ('queued') and fires its onAccepted branch.
          deliver: async (machineId, env) => {
            const peer = pool.deliverTo(machineId);
            if (!peer) return { kind: 'rejected' as const, detail: `no peer url for ${machineId}` };
            const parsed = parseDashboardCreatePayload(env.payload);
            if (parsed && env.messageId.startsWith(`dashboard-create:${env.sessionKey}:`)) await peer.runner(Number(env.sessionKey), parsed);
            return { kind: 'accepted' as const };
          },
          nonce: () => String(++n),
        }, key, target, start, pin),
      } : {}),
    },
  } as never);
  m.app = m.server.getApp();
  return m;
}

function registry(): SessionOwnershipRegistry {
  const nonces = new Set<string>();
  return new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => { nonces.add(k); } });
}

async function listen(m: Machine): Promise<string> {
  return await new Promise<string>((resolve) => {
    listening = m.app.listen(0, '127.0.0.1', () => {
      const a = listening!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
}

beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-machine-choice-e2e-')); });
afterEach(async () => {
  if (listening) await new Promise<void>((r) => listening!.close(() => r()));
  listening = null;
  SafeFsExecutor.safeRmSync(tmpRoot, { recursive: true, force: true, operation: 'tests/e2e/dashboard-machine-choice-lifecycle:cleanup' });
});

const createTopic = (m: Machine, body: Record<string, unknown>) =>
  request(m.app).post('/sessions/create').set(auth).set('X-Instar-Request', '1').send({ platform: 'telegram', ...body });

describe('dashboard machine choice — feature is alive', () => {
  it('Phase 1: a single-machine server answers a machine pick with 400 machine-choice-unavailable (never 500), and creates nothing', async () => {
    const solo = boot('solo', { 'claude-code': process.execPath });
    const r = await createTopic(solo, { name: 'x', machine: 'Laptop' }).expect(400);
    expect(r.body.code).toBe('machine-choice-unavailable');
    expect(solo.spawned).toEqual([]);
  });

  it('the dashboard ships the Machine select wired to /pool', async () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'index.html'), 'utf-8');
    expect(html).toContain('id="newSessionMachine"');
    expect(html).toContain("fetch('/pool'");
    expect(html).toContain('payload.machine = machineSel.value');
  });
});

describe('dashboard machine choice — two machines', () => {
  it('a topic created on the Laptop from the Studio dashboard runs ON the Laptop, on the door the Laptop validated', async () => {
    const reg = registry();
    // codex is installed on the laptop only.
    let laptop: Machine | null = null;
    laptop = boot('laptop', { 'claude-code': process.execPath, 'codex-cli': process.execPath }, {
      self: 'laptop', registry: reg, peers: () => [], deliverTo: () => null,
    });
    const laptopUrl = await listen(laptop);
    const studio = boot('studio', { 'claude-code': process.execPath, 'codex-cli': null }, {
      self: 'studio', registry: reg,
      peers: () => [{ machineId: 'laptop', url: laptopUrl }],
      deliverTo: (id) => (id === 'laptop' ? laptop : null),
    });

    const r = await createTopic(studio, { name: 'remote-one', machine: 'Laptop', framework: 'codex-cli', model: 'gpt-6-astra' }).expect(201);
    const topicId = r.body.topicId as number;
    expect(r.body).toMatchObject({ started: 'requested', machine: { machineId: 'laptop' }, profileValidatedOn: 'laptop' });

    // Ownership is ACTIVE on the laptop; the pin names it.
    expect(reg.read(String(topicId))).toMatchObject({ ownerMachineId: 'laptop', status: 'active' });
    expect(studio.pins.get(String(topicId))?.preferredMachine).toBe('laptop');

    // The done bar, read from the TARGET: a running session for the topic, with the model.
    const sessions = await request(laptop.app).get('/sessions').set(auth).expect(200);
    const list = (Array.isArray(sessions.body) ? sessions.body : sessions.body.sessions) as Array<{ platformId?: number; tmuxSession: string; framework?: string; model?: string }>;
    const s = list.find((x) => x.tmuxSession === `laptop-topic-${topicId}`);
    expect(s).toMatchObject({ framework: 'codex-cli', model: 'gpt-6-astra' });
    expect(laptop.spawned).toEqual([topicId]);

    // Nothing ran or was seeded on the studio; the studio posted the one line.
    expect(studio.spawned).toEqual([]);
    expect(studio.store.get(String(topicId))).toBeNull();
    expect(studio.notices.map((x) => x.text)).toEqual(['This topic is assigned to Laptop; its session is starting there. Requested: Codex CLI · gpt-6-astra.']);
    expect(laptop.notices).toEqual([]);
  });

  it('GET /pool reports which machine is serving the page', async () => {
    const reg = registry();
    const studio = boot('studio', { 'claude-code': process.execPath }, { self: 'studio', registry: reg, peers: () => [], deliverTo: () => null });
    const pool = await request(studio.app).get('/pool').set(auth).expect(200);
    expect(pool.body.selfMachineId).toBe('studio');
  });
});
