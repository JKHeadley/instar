/**
 * Integration — the Machine choice in the dashboard New Session box over the full
 * HTTP pipeline (docs/specs/dashboard-new-session-machine-choice.md §5).
 *
 * TWO real route stacks: the HOLDER (the lease holder serving the dashboard) and a
 * TARGET peer listening on a real port, so the §3.4 step-0 pre-flight
 * (`POST /topic-profile/validate-choice`) and the options proxy run against the
 * target's REAL validator and inventory. The holder's `startTopicOnMachine` seam
 * is a recorder (its place → deliver → claim core is unit-tested in
 * tests/unit/dashboardMachineChoice.test.ts; the production wiring in the e2e).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface, type ProfileWriteRegime } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { SpawningTopicsRegistry } from '../../src/core/SpawningTopicsRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import {
  NewTopicDefaultStore,
  createSpawnForTopic,
  evaluateSessionPoolLocalClaim,
} from '../../src/core/dashboardTopicProfile.js';
import type { DashboardCreateStart, StartTopicOnMachineResult } from '../../src/core/dashboardMachineChoice.js';

const PRESENT = process.execPath;
const MISSING = '/nonexistent/instar-test/bin/codex';
const FULLY_LIVE: ProfileWriteRegime = { enabled: true, dryRun: false };
const HOLDER = 'm_studio';
const TARGET = 'm_laptop';

let tmpDir: string;
let peerServer: Server | null = null;

interface Built {
  app: express.Express;
  pins: TopicPlacementPinStore;
  disclosures: Array<{ key: string; text: string }>;
  created: string[];
  spawns: number[];
  claims: string[];
  starts: Array<{ key: string; target: string; start: DashboardCreateStart }>;
}

function profileParts(stateDir: string, bins: Record<string, string | null>) {
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
    store, resolver, regime: () => FULLY_LIVE,
    boundOperator: () => null, localModelBinding: () => null,
    legacyFrameworkRespawn: async () => ({ respawned: true }),
    disclose: async () => {}, audit: () => 'seq',
  });
  return { store, resolver, surface };
}

function build(opts: {
  name: string;
  self: string;
  bins: Record<string, string | null>;
  capacities?: Array<Record<string, unknown>>;
  peers?: Array<{ machineId: string; url: string }>;
  seamKind?: 'ready' | 'dark' | 'not-authoritative';
  /** The peer refuses every request with 401 (a machine holding a different API token). */
  peerAuth?: 'refuse';
  /** The signed mesh probe to the target answers this (default true). */
  meshReachable?: boolean;
  /** The start seam reports itself unbound (boot window). */
  seamUnwired?: boolean;
  /** The seam answers ready this many times, then not-authoritative (a lease move). */
  readyCalls?: number;
  pinReplication?: boolean;
  startResult?: StartTopicOnMachineResult;
  noTelegram?: boolean;
  noEmitter?: boolean;
}): Built {
  const stateDir = path.join(tmpDir, opts.name, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const { store, resolver, surface } = profileParts(stateDir, opts.bins);
  const b: Built = {
    app: express(),
    pins: new TopicPlacementPinStore({ filePath: path.join(stateDir, 'state', 'topic-pins.json') }),
    disclosures: [], created: [], spawns: [], claims: [], starts: [],
  };
  let nextTopic = 500;
  const mapped = new Map<number, string>();
  const telegram = {
    findOrCreateForumTopic: async (name: string) => {
      b.created.push(name);
      return name === 'existing' ? { topicId: 42, name, reused: true } : { topicId: ++nextTopic, name, reused: false };
    },
    getSessionForTopic: (t: number) => mapped.get(t) ?? null,
    registerTopicSession: (t: number, s: string) => { mapped.set(t, s); },
    sendToTopic: async () => ({}),
  };
  const guard = new SpawningTopicsRegistry();
  const seamKind = opts.seamKind ?? 'ready';
  let seamCalls = 0;
  const seam = () => { seamCalls++; return evaluateSessionPoolLocalClaim({
    routerLive: () => seamKind !== 'dark',
    replicationOn: true,
    holdsLease: () => seamKind === 'ready' && (opts.readyCalls === undefined || seamCalls <= opts.readyCalls),
    holder: () => ({ machineId: HOLDER, nickname: 'Mac Studio' }),
    ops: {
      place: (sk) => { b.claims.push(`place:${sk}`); return { ok: true }; },
      confirm: (sk) => { b.claims.push(`confirm:${sk}`); return true; },
      release: (sk) => { b.claims.push(`release:${sk}`); return true; },
    },
  }); };
  const ctx = {
    config: { projectName: 'test', projectDir: tmpDir, stateDir, port: 0, authToken: 'tok', sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [], spawnInteractiveSession: async () => 'raw' },
    state: { getJobState: () => null, getSession: () => null },
    telegram: opts.noTelegram ? null : telegram,
    slack: null,
    startTime: new Date(),
    meshSelfId: opts.self,
    machinePoolRegistry: { getCapacities: () => opts.capacities ?? [], getCapacity: (id: string) => (opts.capacities ?? []).find((c) => c.machineId === id) ?? null },
    topicPinStore: b.pins,
    replicatedRecordEmitter: opts.noEmitter ? null : { emit: () => {} },
    resolvePeerUrls: () => opts.peers ?? [],
    topicProfile: {
      store, resolver, surface,
      confirmSlots: new ProfileConfirmSlots({ ttlMs: () => 300_000 }),
      newTopicDefault: new NewTopicDefaultStore(stateDir),
      audit: () => {},
      discloseCreationSeed: async (key: string, text: string) => { b.disclosures.push({ key, text }); },
      spawnForTopic: createSpawnForTopic({
        guard: () => guard,
        telegram: () => telegram,
        spawn: async (topicId) => { b.spawns.push(topicId); return `tmux-${topicId}`; },
      }),
      sessionPoolLocalClaim: seam,
      pinReplicationLive: () => opts.pinReplication ?? true,
      startSeamWired: () => !opts.seamUnwired,
      probeMachineReachable: async (machineId: string) => { b.claims.push(`probe:${machineId}`); return opts.meshReachable ?? true; },
      startTopicOnMachine: async (key: string, target: string, start: DashboardCreateStart, pin?: () => Promise<boolean> | boolean) => {
        b.starts.push({ key, target, start });
        // The pin is written AFTER placement (spec §3.4 step 3e), by the seam.
        b.claims.push(`pin-at-start:${b.pins.get(key) ? 'present' : 'absent'}`);
        const result = opts.startResult ?? { ok: true, epoch: 2, settled: true };
        // Never for a refused start (§3.4 step 3d): released AND unpinned.
        if (result.code !== 'topic-owned-elsewhere' && result.code !== 'start-failed' && result.code !== 'start-superseded') await pin?.();
        return result;
      },
    },
  } as unknown as RouteContext;
  b.app.use(express.json());
  b.app.use('/', createRoutes(ctx));
  return b;
}

const caps = (over: Record<string, Record<string, unknown>> = {}) => [
  { machineId: HOLDER, nickname: 'Mac Studio', online: true, clockSkewStatus: 'ok', seamlessnessFlags: { dashboardCreateReceive: true } },
  { machineId: TARGET, nickname: 'Laptop', online: true, clockSkewStatus: 'ok', quotaState: { blocked: false }, seamlessnessFlags: { dashboardCreateReceive: true }, ...(over[TARGET] ?? {}) },
  { machineId: 'm_mini', nickname: 'Mac Mini', online: false, clockSkewStatus: 'ok', seamlessnessFlags: { dashboardCreateReceive: true } },
  { machineId: 'm_pc', nickname: 'Mama PC', online: true, clockSkewStatus: 'suspect-clock-removed', seamlessnessFlags: { dashboardCreateReceive: true } },
  { machineId: 'm_old', nickname: 'Old Box', online: true, clockSkewStatus: 'ok', seamlessnessFlags: {} },
];

/** The target peer: real routes, codex installed (the holder has none). */
async function startPeer(peerAuth?: 'refuse'): Promise<string> {
  const peer = peerAuth === 'refuse'
    ? { app: express().use((_req, res) => { res.status(401).json({ error: 'Invalid auth token' }); }) }
    : build({ name: 'peer', self: TARGET, bins: { 'claude-code': PRESENT, 'codex-cli': PRESENT } });
  return await new Promise<string>((resolve) => {
    peerServer = peer.app.listen(0, '127.0.0.1', () => {
      const addr = peerServer!.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

async function holderWithPeer(over: Parameters<typeof build>[0] extends infer T ? Partial<T> : never = {}): Promise<Built> {
  const url = await startPeer(over.peerAuth);
  return build({
    name: 'holder', self: HOLDER, bins: { 'claude-code': PRESENT, 'codex-cli': MISSING },
    capacities: caps(), peers: [{ machineId: TARGET, url }], ...over,
  });
}

const create = (b: Built, body: Record<string, unknown>, intent = true) => {
  const r = request(b.app).post('/sessions/create');
  return (intent ? r.set('X-Instar-Request', '1') : r).send(body);
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-machine-choice-int-'));
});
afterEach(async () => {
  if (peerServer) await new Promise<void>((r) => peerServer!.close(() => r()));
  peerServer = null;
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/dashboard-machine-choice-routes:cleanup' });
});

describe('POST /sessions/create — remote machine pick', () => {
  it('pre-flights the door on the TARGET, pins, posts the line, starts there; never claims, seeds or spawns locally', async () => {
    const h = await holderWithPeer();
    // codex is missing on the holder but installed on the target: accepted.
    const r = await create(h, { name: 'on-laptop', machine: 'laptop', framework: 'codex-cli', model: 'gpt-6-astra' }).expect(201);
    expect(r.body).toMatchObject({
      ok: true, session: null, started: 'requested',
      machine: { machineId: TARGET, nickname: 'Laptop' },
      profileRequested: { framework: 'codex-cli', model: 'gpt-6-astra' },
      profileValidatedOn: TARGET,
    });
    const key = String(r.body.topicId);
    expect(h.pins.get(key)).toMatchObject({ preferredMachine: TARGET, pinned: true });
    expect(h.starts).toEqual([{ key, target: TARGET, start: { framework: 'codex-cli', model: 'gpt-6-astra', source: 'dashboard-create', machineNickname: 'Laptop' } }]);
    expect(h.disclosures).toEqual([{ key, text: 'This topic is assigned to Laptop; its session is starting there. Requested: Codex CLI · gpt-6-astra.' }]);
    expect(h.claims).toEqual([`probe:${TARGET}`, 'pin-at-start:absent']);
    expect(h.spawns).toEqual([]);
  });

  it('the target does not answer the signed mesh probe ⇒ 502 machine-unreachable reason mesh; nothing created', async () => {
    const h = await holderWithPeer({ meshReachable: false });
    const r = await create(h, { name: 'half', machine: 'Laptop', framework: 'codex-cli' }).expect(502);
    expect(r.body).toMatchObject({ code: 'machine-unreachable', reason: 'mesh', step: 'validate-on-target' });
    expect(h.created).toEqual([]);
    expect(h.starts).toEqual([]);
  });

  it('the start seam not yet bound ⇒ 400 start-not-wired before anything is created', async () => {
    const h = await holderWithPeer({ seamUnwired: true });
    const r = await create(h, { name: 'early', machine: 'Laptop' }).expect(400);
    expect(r.body).toMatchObject({ code: 'machine-choice-unavailable', reason: 'start-not-wired' });
    expect(h.created).toEqual([]);
  });

  it('superseded by a newer placement on the SAME target ⇒ 202 naming it, no pin, no line', async () => {
    const h = await holderWithPeer({ startResult: { ok: false, code: 'start-superseded', delivered: 'accepted', ownerNow: TARGET, epochNow: 4, statusNow: 'active' } });
    const r = await create(h, { name: 'same', machine: 'Laptop' }).expect(202);
    expect(r.body).toMatchObject({ ownership: 'superseded', ownerNow: { machineId: TARGET, status: 'active', epoch: 4 } });
    expect(r.body.error).toContain('newer placement on Laptop');
    expect(h.pins.get(String(r.body.topicId))).toBeNull();
    expect(h.disclosures).toEqual([]);
  });

  it('a pick the TARGET refuses ⇒ 400 with the target\'s code; nothing created', async () => {
    const h = await holderWithPeer();
    const r = await create(h, { name: 'bad', machine: TARGET, framework: 'claude-code', model: 'gpt-6-astra' }).expect(400);
    expect(r.body).toMatchObject({ code: 'invalid-model', step: 'validate-on-target' });
    expect(h.created).toEqual([]);
    expect(h.starts).toEqual([]);
  });

  it('no pick and no default ⇒ starts on the target with no door to apply', async () => {
    const h = await holderWithPeer();
    const r = await create(h, { name: 'plain', machine: 'Laptop' }).expect(201);
    expect(h.starts[0].start).toEqual({ framework: null, model: null, source: null, machineNickname: 'Laptop' });
    expect(r.body.profileRequested).toBeNull();
    expect(h.disclosures[0].text).toBe('This topic is assigned to Laptop; its session is starting there.');
  });

  it('the lease moves between validation and placement ⇒ 409, nothing placed or started, but the pin is written', async () => {
    const h = await holderWithPeer({ readyCalls: 2 });
    const r = await create(h, { name: 'moved', machine: 'Laptop' }).expect(409);
    expect(r.body).toMatchObject({ code: 'placement-not-authoritative-here', step: 'place', pinned: true });
    expect(h.starts).toEqual([]);
    expect(h.pins.get(String(r.body.topicId))?.preferredMachine).toBe(TARGET);
  });

  it('a once-seen clock divergence (not removed) is still placeable, as placement itself allows', async () => {
    const h = await holderWithPeer({ capacities: caps({ [TARGET]: { clockSkewStatus: 'divergence-detected-once' } }) });
    await create(h, { name: 'once', machine: 'Laptop' }).expect(201);
  });

  it('the peer refuses this machine\'s token on the pre-flight ⇒ 502 machine-unreachable reason peer-auth; nothing created', async () => {
    const h = await holderWithPeer({ peerAuth: 'refuse' });
    const r = await create(h, { name: 'noauth', machine: 'Laptop', framework: 'claude-code' }).expect(502);
    expect(r.body).toMatchObject({ code: 'machine-unreachable', reason: 'peer-auth', step: 'validate-on-target' });
    expect(h.created).toEqual([]);
  });

  it('superseded during the deliver round trip ⇒ 202 ownership:superseded, no pin, no line', async () => {
    const h = await holderWithPeer({ startResult: { ok: false, code: 'start-superseded', delivered: 'accepted', ownerNow: 'm_mini', epochNow: 7, statusNow: 'active' } });
    const r = await create(h, { name: 'taken', machine: 'Laptop' }).expect(202);
    expect(r.body).toMatchObject({ ok: true, ownership: 'superseded', started: 'requested', ownerNow: { machineId: 'm_mini', nickname: 'Mac Mini' } });
    expect(r.body.error).toContain('Mac Mini took ownership');
    expect(h.pins.get(String(r.body.topicId))).toBeNull();
    expect(h.disclosures).toEqual([]);
  });

  it('ownership not confirmed ⇒ 202 with ownership:not-confirmed and an honest line', async () => {
    const h = await holderWithPeer({ startResult: { ok: true, epoch: 1, settled: false } });
    const r = await create(h, { name: 'unsettled', machine: 'Laptop' }).expect(202);
    expect(r.body).toMatchObject({ ok: true, ownership: 'not-confirmed', started: 'requested' });
    expect(r.body.notices).toContain('ownership-not-confirmed');
  });

  it('topic-owned-elsewhere at placement ⇒ 409, and no pin is written', async () => {
    const h = await holderWithPeer({ startResult: { ok: false, code: 'topic-owned-elsewhere', reason: 'record-active' } });
    const r = await create(h, { name: 'owned', machine: 'Laptop' }).expect(409);
    expect(r.body.code).toBe('topic-owned-elsewhere');
    expect(h.pins.get(String(r.body.topicId))).toBeNull();
    expect(h.disclosures).toEqual([]);
  });

  it('a refused start ⇒ 502 naming the step; topic kept, NOT pinned, released; NO line posted', async () => {
    const h = await holderWithPeer({ startResult: { ok: false, code: 'start-failed', error: '403 not-router', released: true, settled: true } });
    const r = await create(h, { name: 'fails', machine: 'Laptop' }).expect(502);
    expect(r.body).toMatchObject({ code: 'start-remote-failed', step: 'start-remote', released: true, notices: [] });
    expect(r.body.error).toContain('is not pinned');
    expect(r.body.error).toContain('were not applied');
    expect(h.pins.get(String(r.body.topicId))).toBeNull();
    expect(h.disclosures).toEqual([]);
  });

  it('a refused start whose ownership could not be confirmed ⇒ 502 carrying the notice and the move hint', async () => {
    const h = await holderWithPeer({ startResult: { ok: false, code: 'start-failed', error: '403 not-router', released: false, settled: false } });
    const r = await create(h, { name: 'fails-unsettled', machine: 'Laptop' }).expect(502);
    expect(r.body.notices).toEqual(['ownership-not-confirmed']);
    expect(r.body.error).toContain('move this to Laptop');
    expect(h.pins.get(String(r.body.topicId))).toBeNull();
  });

  it('an unknown start outcome ⇒ 202 started:unknown, honest text, the line still posted', async () => {
    const h = await holderWithPeer({ startResult: { ok: false, code: 'start-unknown', error: 'aborted', settled: true } });
    const r = await create(h, { name: 'maybe', machine: 'Laptop' }).expect(202);
    expect(r.body).toMatchObject({ ok: true, started: 'unknown', machine: { machineId: TARGET } });
    expect(r.body.error).toContain('may or may not have started');
    expect(h.disclosures).toHaveLength(1);
    expect(h.disclosures[0].text).toContain('No confirmation came back');
  });

  it('an unreachable target ⇒ 502 machine-unreachable before anything is created', async () => {
    const h = build({ name: 'holder', self: HOLDER, bins: { 'claude-code': PRESENT }, capacities: caps(), peers: [{ machineId: TARGET, url: 'http://127.0.0.1:1' }] });
    const r = await create(h, { name: 'x', machine: 'Laptop', framework: 'claude-code' }).expect(502);
    expect(r.body).toMatchObject({ code: 'machine-unreachable', step: 'validate-on-target' });
    expect(h.created).toEqual([]);
  });
});

describe('POST /sessions/create — refusals create nothing', () => {
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ['unknown machine', { machine: 'Toaster' }, 404, 'unknown-machine'],
    ['offline machine', { machine: 'Mac Mini' }, 409, 'machine-offline'],
    ['clock out of step', { machine: 'Mama PC' }, 409, 'machine-clock-suspect'],
    ['not updated', { machine: 'Old Box' }, 409, 'machine-needs-update'],
    ['non-string machine', { machine: 7 }, 400, 'machine-invalid'],
    ['headless platform', { machine: 'Laptop', platform: 'headless' }, 400, 'machine-needs-telegram'],
  ];
  for (const [label, body, status, code] of cases) {
    it(label, async () => {
      const h = build({ name: 'holder', self: HOLDER, bins: { 'claude-code': PRESENT }, capacities: caps() });
      const r = await create(h, { name: 'n', ...body }).expect(status);
      expect(r.body.code).toBe(code);
      expect(h.created).toEqual([]);
    });
  }

  it('pool dark or pin replication dark ⇒ machine-choice-unavailable', async () => {
    for (const over of [{ seamKind: 'dark' as const }, { pinReplication: false }, { noEmitter: true }]) {
      const h = build({ name: `h-${Object.keys(over)[0]}`, self: HOLDER, bins: { 'claude-code': PRESENT }, capacities: caps(), ...over });
      const r = await create(h, { name: 'n', machine: 'Laptop' }).expect(400);
      expect(r.body.code).toBe('machine-choice-unavailable');
      expect(r.body.reason).toBe('seamKind' in over ? 'pool-dark' : 'pin-replication-dark');
      expect(h.created).toEqual([]);
    }
  });

  it('missing intent header ⇒ 403; a reused topic ⇒ 409 topic-exists (never moved)', async () => {
    const h = build({ name: 'holder', self: HOLDER, bins: { 'claude-code': PRESENT }, capacities: caps() });
    await create(h, { name: 'n', machine: 'Mac Studio' }, false).expect(403);
    const r = await create(h, { name: 'existing', machine: 'Mac Studio' }).expect(409);
    expect(r.body.code).toBe('topic-exists');
    expect(h.pins.get('42')).toBeNull();
  });

  it('not the lease holder ⇒ the existing 409 placement-not-authoritative-here', async () => {
    const h = build({ name: 'holder', self: HOLDER, bins: { 'claude-code': PRESENT }, capacities: caps(), seamKind: 'not-authoritative' });
    const r = await create(h, { name: 'n', machine: 'Laptop' }).expect(409);
    expect(r.body.code).toBe('placement-not-authoritative-here');
    expect(h.created).toEqual([]);
  });
});

describe('POST /sessions/create — this machine and Automatic', () => {
  it('this machine ⇒ the local saga runs AND the topic is pinned here', async () => {
    const h = build({ name: 'holder', self: HOLDER, bins: { 'claude-code': PRESENT }, capacities: caps() });
    const r = await create(h, { name: 'here', machine: 'mac studio' }).expect(201);
    expect(r.body).toMatchObject({ ok: true, started: 'here', machine: { machineId: HOLDER, nickname: 'Mac Studio' } });
    const key = String(r.body.topicId);
    expect(h.pins.get(key)?.preferredMachine).toBe(HOLDER);
    expect(h.claims).toEqual([`place:${key}`, `confirm:${key}`]);
    // Pinned only after the claim placed ownership here.
    expect(h.spawns).toEqual([r.body.topicId]);
    expect(h.starts).toEqual([]);
  });

  it('"auto" behaves exactly like omitting the field (no header needed, no pin)', async () => {
    const h = build({ name: 'holder', self: HOLDER, bins: { 'claude-code': PRESENT }, capacities: caps() });
    const a = await create(h, { name: 'a', machine: 'auto' }, false).expect(201);
    const b = await create(h, { name: 'b' }, false).expect(201);
    for (const r of [a, b]) {
      expect(r.body.machine).toBeUndefined();
      expect(h.pins.get(String(r.body.topicId))).toBeNull();
    }
  });
});

describe('the target-side helper routes', () => {
  it('POST /topic-profile/validate-choice answers the parent validator; needs the intent header', async () => {
    const t = build({ name: 't', self: TARGET, bins: { 'claude-code': PRESENT, 'codex-cli': MISSING } });
    await request(t.app).post('/topic-profile/validate-choice').send({ framework: 'claude-code' }).expect(403);
    const ok = await request(t.app).post('/topic-profile/validate-choice').set('X-Instar-Request', '1').send({ framework: 'claude-code' }).expect(200);
    expect(ok.body).toMatchObject({ ok: true, framework: 'claude-code' });
    const no = await request(t.app).post('/topic-profile/validate-choice').set('X-Instar-Request', '1').send({ framework: 'codex-cli' }).expect(400);
    expect(no.body).toMatchObject({ ok: false, code: 'dashboard-unavailable-door' });
  });

  it('GET /topic-profile/options?machine= proxies the peer\'s doors; GET /pool carries selfMachineId', async () => {
    const h = await holderWithPeer();
    const local = await request(h.app).get('/topic-profile/options').expect(200);
    const remote = await request(h.app).get(`/topic-profile/options?machine=${TARGET}`).expect(200);
    const codex = (o: { doors: Array<{ framework: string; selectable: boolean }> }) => o.doors.find((d) => d.framework === 'codex-cli')?.selectable;
    expect(codex(local.body)).toBe(false);
    expect(codex(remote.body)).toBe(true);
    expect(remote.body.machine).toBe(TARGET);
    await request(h.app).get('/topic-profile/options?machine=m_nowhere').expect(404);
    const pool = await request(h.app).get('/pool').expect(200);
    expect(pool.body.selfMachineId).toBe(HOLDER);
  });
});
