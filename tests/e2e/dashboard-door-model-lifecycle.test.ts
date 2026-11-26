/**
 * E2E lifecycle — dashboard door + model controls
 * (docs/specs/dashboard-door-model-controls.md §5, Tier 3).
 *
 * Composes a REAL AgentServer the way src/commands/server.ts composes
 * `_topicProfileCtx`: real TopicProfileStore + resolver + write surface +
 * NewTopicDefaultStore + SpawningTopicsRegistry + createSpawnForTopic, and — on
 * the pool path — createDashboardPoolClaimOps over a REAL SessionOwnershipRegistry
 * (the exact functions server.ts wires). The spawn records a Session in the
 * StateManager exactly like SessionManager.spawnInteractiveSession, so
 * `GET /sessions` reports the LAUNCHED framework/model.
 *
 * Pool note: the repo has no in-process two-server router harness, so the pool
 * cases run two machines' seams against ONE authoritative ownership registry
 * (the holder's, single-router topology) — the spec's named fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { SpawningTopicsRegistry } from '../../src/core/SpawningTopicsRegistry.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore, type CasResult } from '../../src/core/SessionOwnershipRegistry.js';
import { confirmLocalPlacementAfterDelivery } from '../../src/core/SessionPoolLocalClaim.js';
import {
  NewTopicDefaultStore,
  createSpawnForTopic,
  createDashboardPoolClaimOps,
  evaluateSessionPoolLocalClaim,
  type SessionPoolLocalClaimAnswer,
} from '../../src/core/dashboardTopicProfile.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

const AUTH = 'test-dash-door-model-e2e';
const auth = { Authorization: `Bearer ${AUTH}` };

interface Machine {
  server: AgentServer;
  app: ReturnType<AgentServer['getApp']>;
  stateDir: string;
  store: TopicProfileStore;
  resolver: TopicProfileResolver;
  state: StateManager;
  spawned: number[];
  topicsCreated: number[];
}

let tmpRoot: string;
let nextTopic = 7000;

function auditRows(stateDir: string): Array<Record<string, unknown>> {
  const p = path.join(stateDir, '..', 'logs', 'topic-profile-changes.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function boot(name: string, opts: { seam?: () => SessionPoolLocalClaimAnswer; spawnThrows?: boolean; stateDir?: string } = {}): Machine {
  const stateDir = opts.stateDir ?? path.join(tmpRoot, name, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  const config = { projectName: name, agentName: name, projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: AUTH } as InstarConfig;
  const store = new TopicProfileStore({
    stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
    legacyFrameworksPath: path.join(stateDir, 'state', 'topic-frameworks.json'),
    isDryRun: () => false,
  });
  const resolver = new TopicProfileResolver({
    store,
    defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}),
    configProfileDefaults: () => ({}),
    frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined,
    localModelBinding: () => null,
    frameworkBinaryPath: () => process.execPath, // every door "installed" (verified)
  });
  // Mirror of server.ts's appendTopicProfileAudit sink (logs/topic-profile-changes.jsonl).
  const audit = (event: Record<string, unknown>): void => {
    const logs = path.join(stateDir, '..', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.appendFileSync(path.join(logs, 'topic-profile-changes.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  };
  const surface = new TopicProfileWriteSurface({
    store, resolver,
    regime: () => ({ enabled: true, dryRun: false }), // Echo: fully-live
    boundOperator: () => null,
    localModelBinding: () => null,
    legacyFrameworkRespawn: async () => ({ respawned: false }),
    disclose: async () => {},
    audit: (e) => { audit(e); return 'seq'; },
  });
  const state = new StateManager(stateDir);
  const topicToSession = new Map<number, string>();
  const m = { stateDir, store, resolver, state, spawned: [] as number[], topicsCreated: [] as number[] } as Machine;
  const telegram = {
    findOrCreateForumTopic: async (topicName: string) => {
      const topicId = ++nextTopic;
      m.topicsCreated.push(topicId);
      return { topicId, name: topicName, reused: false };
    },
    getSessionForTopic: (t: number) => topicToSession.get(t) ?? null,
    getTopicForSession: (s: string) => [...topicToSession.entries()].find(([, v]) => v === s)?.[0] ?? null,
    getTopicName: () => null,
    registerTopicSession: (t: number, s: string) => { topicToSession.set(t, s); },
    sendToTopic: async () => ({}),
  };
  const guard = new SpawningTopicsRegistry();
  // The chokepoint's resolve → spawn contract; the session record mirrors
  // SessionManager.spawnInteractiveSession (framework + model persisted).
  const spawn = async (topicId: number, topicName: string): Promise<string> => {
    const p = resolver.resolve(topicId);
    if (opts.spawnThrows) throw new Error('tmux refused to start');
    const tmuxSession = `${name}-topic-${topicId}`;
    const session: Session = {
      id: `s-${topicId}`, name: topicName, status: 'running', tmuxSession,
      startedAt: new Date().toISOString(), framework: p.framework, ...(p.model ? { model: p.model } : {}),
    } as Session;
    state.saveSession(session);
    m.spawned.push(topicId);
    return tmuxSession;
  };
  m.server = new AgentServer({
    config,
    sessionManager: createMockSessionManager() as never,
    state,
    telegram: telegram as never,
    topicProfile: {
      store, resolver, surface,
      confirmSlots: new ProfileConfirmSlots({ ttlMs: () => 300_000 }),
      newTopicDefault: new NewTopicDefaultStore(stateDir),
      audit,
      discloseCreationSeed: async () => {},
      spawnForTopic: createSpawnForTopic({ guard: () => guard, telegram: () => telegram, spawn }),
      ...(opts.seam ? { sessionPoolLocalClaim: opts.seam } : {}),
    },
  } as never);
  m.app = m.server.getApp();
  return m;
}

beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-door-model-e2e-')); });
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpRoot, { recursive: true, force: true, operation: 'tests/e2e/dashboard-door-model-lifecycle:cleanup' });
});

const createTopic = (m: Machine, body: Record<string, unknown>) =>
  request(m.app).post('/sessions/create').set(auth).set('X-Instar-Request', '1').send({ platform: 'telegram', ...body });
const sessionFor = async (m: Machine, topicId: number) => {
  const r = await request(m.app).get('/sessions').set(auth).expect(200);
  const list = Array.isArray(r.body) ? r.body : r.body.sessions;
  return list.find((s: { platformId?: number }) => s.platformId === topicId);
};

describe('dashboard door + model — single machine (production AgentServer)', () => {
  it('Phase 1: GET /topic-profile/options is alive (200, not 503)', async () => {
    const m = boot('solo');
    const r = await request(m.app).get('/topic-profile/options').set(auth);
    expect(r.status).toBe(200);
    expect(r.body.regime).toBe('fully-live');
    expect(r.body.doors.length).toBeGreaterThan(0);
  });

  it('a topic created on codex-cli launches with the codex framework in GET /sessions', async () => {
    const m = boot('solo');
    const r = await createTopic(m, { name: 'codex work', framework: 'codex-cli', model: 'gpt-6-astra' }).expect(201);
    const s = await sessionFor(m, r.body.topicId);
    expect(s).toMatchObject({ platform: 'telegram', framework: 'codex-cli', model: 'gpt-6-astra' });
    expect(auditRows(m.stateDir).some(a => a.type === 'creation-seed' && a.topic === String(r.body.topicId))).toBe(true);
  });

  it('a create with no pick and a default set launches on the default', async () => {
    const m = boot('solo');
    await request(m.app).post('/topic-profile/new-topic-default').set(auth).set('X-Instar-Request', '1')
      .send({ framework: 'gemini-cli' }).expect(200);
    const r = await createTopic(m, { name: 'defaulted' }).expect(201);
    expect((await sessionFor(m, r.body.topicId)).framework).toBe('gemini-cli');
    expect(m.store.resolve(r.body.topicId)?.updatedBy).toBe('system:new-topic-default');
  });

  it('a pre-existing unpinned topic — session reaped, server restarted — does NOT change when the default is set or changed', async () => {
    const m = boot('solo');
    const r = await createTopic(m, { name: 'old topic' }).expect(201);
    const key = String(r.body.topicId);
    expect(m.store.get(key)).toBeNull();
    // Reaped + restart: a new server over the same state dir.
    const restarted = boot('solo', { stateDir: m.stateDir });
    await request(restarted.app).post('/topic-profile/new-topic-default').set(auth).set('X-Instar-Request', '1').send({ framework: 'codex-cli' }).expect(200);
    await request(restarted.app).post('/topic-profile/new-topic-default').set(auth).set('X-Instar-Request', '1').send({ framework: 'gemini-cli' }).expect(200);
    expect(restarted.store.get(key)).toBeNull();
    expect(restarted.resolver.resolve(key).framework).toBe('claude-code');
    const g = await request(restarted.app).get(`/topic-profile/${key}`).set(auth).expect(200);
    expect(g.body.pin).toBeNull();
  });

  it('a Telegram-created topic launches on the global defaults exactly as today — no seed, no audit row', async () => {
    const m = boot('solo');
    await request(m.app).post('/topic-profile/new-topic-default').set(auth).set('X-Instar-Request', '1').send({ framework: 'codex-cli' }).expect(200);
    // A topic the operator started in Telegram never passes through /sessions/create.
    const telegramTopic = '88001';
    const resolved = m.resolver.resolve(telegramTopic);
    expect(resolved).toMatchObject({ framework: 'claude-code', model: undefined, sources: { framework: 'global-default', model: 'account-default' } });
    expect(m.store.get(telegramTopic)).toBeNull();
    expect(auditRows(m.stateDir).filter(a => a.topic === telegramTopic)).toEqual([]);
  });
});

describe('dashboard door + model — pool (two machines, one authoritative registry)', () => {
  function pool() {
    const nonces = new Set<string>();
    const registry = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: k => nonces.has(k), recordNonce: k => { nonces.add(k); } });
    const journal: Array<{ sk: string; reason: string; ok: boolean }> = [];
    let holder = 'studio';
    let n = 0;
    const seamFor = (self: string) => (): SessionPoolLocalClaimAnswer => evaluateSessionPoolLocalClaim({
      routerLive: () => true,
      replicationOn: true,
      holdsLease: () => holder === self,
      holder: () => ({ machineId: holder, nickname: holder === 'studio' ? 'Mac Studio' : 'Laptop' }),
      ops: createDashboardPoolClaimOps({
        ownershipRegistry: registry,
        selfMachineId: self,
        nextNonce: (kind) => `${self}:${kind}:${++n}`,
        emitPlacement: (sk: string, r: CasResult, reason: string) => { journal.push({ sk, reason, ok: r.ok }); },
        confirmLocal: (sk) => confirmLocalPlacementAfterDelivery({
          selfMachineId: self,
          readOwnership: (k) => registry.read(k),
          claimOwnership: (k, machineId) => {
            const r = registry.cas({ type: 'claim', machineId }, { sessionKey: k, sender: self, nonce: `${self}:lcl:${++n}` });
            return { confirmed: r.ok, afterConfirm: () => journal.push({ sk: k, reason: 'placed', ok: r.ok }) };
          },
        }, sk),
      }),
    });
    return { registry, journal, seamFor, setHolder: (h: string) => { holder = h; } };
  }

  it('a dashboard-created topic is placed on the creating machine (active), and no second seed occurs on the peer', async () => {
    const p = pool();
    const studio = boot('studio', { seam: p.seamFor('studio') });
    const laptop = boot('laptop', { seam: p.seamFor('laptop') });
    const r = await createTopic(studio, { name: 'pooled', framework: 'codex-cli' }).expect(201);
    const key = String(r.body.topicId);
    expect(r.body.placement).toBe('confirmed');
    // The first inbound message routes to the owner of an ACTIVE record — the creator.
    expect(p.registry.read(key)).toMatchObject({ ownerMachineId: 'studio', status: 'active' });
    expect(p.registry.ownerOf(key)).toBe('studio');
    expect(p.journal.filter(j => j.sk === key).map(j => j.reason)).toEqual(['placed', 'placed']);
    expect(laptop.store.get(key)).toBeNull();
    expect(auditRows(laptop.stateDir)).toEqual([]);
  });

  it('any create on the non-holder is refused naming the holder, and creates nothing', async () => {
    const p = pool();
    const laptop = boot('laptop', { seam: p.seamFor('laptop') });
    for (const body of [{ name: 'a', framework: 'codex-cli' }, { name: 'b' }]) {
      const r = await createTopic(laptop, body).expect(409);
      expect(r.body).toMatchObject({ code: 'placement-not-authoritative-here', holderMachineId: 'studio', holderNickname: 'Mac Studio' });
    }
    expect(laptop.topicsCreated).toEqual([]);
  });

  it('spawn failure leaves the record released, the 500 names the step, and a later message can be placed on some machine', async () => {
    const p = pool();
    const studio = boot('studio', { seam: p.seamFor('studio'), spawnThrows: true });
    const r = await createTopic(studio, { name: 'doomed', framework: 'codex-cli' }).expect(500);
    const key = String(r.body.topicId);
    expect(r.body).toMatchObject({ step: 'spawn', placement: 'released', pinRetained: true });
    expect(p.registry.read(key)?.status).toBe('released');
    // The router's next placement for that topic succeeds (here: on the laptop).
    const next = p.registry.cas({ type: 'place', machineId: 'laptop' }, { sessionKey: key, sender: 'studio', nonce: 'router:c:next' });
    expect(next.ok).toBe(true);
    expect(p.registry.ownerOf(key)).toBe('laptop');
  });
});
