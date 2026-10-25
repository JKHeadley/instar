/**
 * Integration — dashboard door + model controls over the full HTTP pipeline
 * (docs/specs/dashboard-door-model-controls.md §5).
 *
 * REAL TopicProfileStore + resolver + write surface + NewTopicDefaultStore +
 * SpawningTopicsRegistry + the createSpawnForTopic thunk, behind createRoutes.
 * The Telegram adapter and SessionManager are recording fakes. The spawn dep is
 * a faithful stand-in for spawnSessionForTopic's resolve → notices → spawn
 * sequence (the real chokepoint's silentStart is proven in
 * tests/unit/spawn-session-silent-start.test.ts); it records the pin at spawn
 * time so "seeded BEFORE spawn" is observed, not assumed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { TopicProfileStore, type TopicProfile } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface, type ProfileWriteRegime } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { SpawningTopicsRegistry } from '../../src/core/SpawningTopicsRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  NewTopicDefaultStore,
  createSpawnForTopic,
  evaluateSessionPoolLocalClaim,
  type SessionPoolLocalClaimAnswer,
} from '../../src/core/dashboardTopicProfile.js';

const PRESENT = process.execPath;
const MISSING = '/nonexistent/instar-test/bin/codex';
const FULLY_LIVE: ProfileWriteRegime = { enabled: true, dryRun: false };

let tmpDir: string;
let stateDir: string;

interface Harness {
  app: express.Express;
  store: TopicProfileStore;
  resolver: TopicProfileResolver;
  guard: SpawningTopicsRegistry;
  audits: Array<Record<string, unknown>>;
  disclosures: Array<{ key: string; text: string }>;
  created: string[];
  registered: Array<[number, string, string | undefined]>;
  mapped: Map<number, string>;
  attentionItems: unknown[];
  sent: Array<{ topicId: number; text: string }>;
  spawns: Array<{ topicId: number; name: string; opts: Record<string, unknown>; pinAtSpawn: TopicProfile | null }>;
  order: string[];
}

function build(opts: {
  regime?: ProfileWriteRegime;
  bins?: Record<string, string | null>;
  boundOperator?: boolean;
  seam?: () => SessionPoolLocalClaimAnswer;
  spawnThrows?: boolean;
  registerThrows?: boolean;
  topicCreateFails?: boolean;
  noTelegram?: boolean;
  operatorProof?: string;
  /** The spawningTopics guard ref is null (Telegram routing never wired). */
  guardUnwired?: boolean;
  /** Runs inside the spawn, before it resolves the profile. */
  beforeSpawn?: () => void;
} = {}): Harness {
  const regime = opts.regime ?? FULLY_LIVE;
  const bins = opts.bins ?? { 'claude-code': PRESENT, 'codex-cli': PRESENT };
  const store = new TopicProfileStore({ stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'), isDryRun: () => regime.dryRun });
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
    store,
    resolver,
    regime: () => regime,
    boundOperator: () => (opts.boundOperator ? { platform: 'telegram', uid: '777' } : null),
    localModelBinding: () => null,
    legacyFrameworkRespawn: async () => ({ respawned: true }),
    disclose: async () => {},
    audit: () => 'seq',
  });
  const h = {
    store, resolver,
    guard: new SpawningTopicsRegistry(),
    audits: [], disclosures: [], created: [], registered: [], mapped: new Map(),
    attentionItems: [], sent: [], spawns: [], order: [],
  } as unknown as Harness;
  let nextTopic = 900;
  const telegram = {
    findOrCreateForumTopic: async (name: string) => {
      if (opts.topicCreateFails) throw new Error('telegram 500');
      h.created.push(name);
      h.order.push('create-topic');
      return name === 'existing' ? { topicId: 42, name, reused: true } : { topicId: ++nextTopic, name, reused: false };
    },
    getSessionForTopic: (t: number) => h.mapped.get(t) ?? null,
    registerTopicSession: (t: number, s: string, name?: string) => {
      if (opts.registerThrows) throw new Error('adapter down');
      h.registered.push([t, s, name]);
      h.mapped.set(t, s);
    },
    sendToTopic: async (topicId: number, text: string) => { h.sent.push({ topicId, text }); return {}; },
    createAttentionItem: async (item: unknown) => { h.attentionItems.push(item); return item; },
  };
  const spawnDep = async (topicId: number, name: string): Promise<string> => {
    h.order.push('spawn');
    opts.beforeSpawn?.();
    const pinAtSpawn = store.resolve(topicId);
    const p = resolver.resolve(topicId);
    for (const n of p.notices) await telegram.sendToTopic(topicId, n);
    if (opts.spawnThrows) throw new Error('tmux refused');
    const spawnOpts = { telegramTopicId: topicId, framework: p.framework, ...(p.model ? { defaultModel: p.model } : {}) };
    h.spawns.push({ topicId, name, opts: spawnOpts, pinAtSpawn });
    return `tmux-${topicId}`;
  };
  const ctx = {
    config: {
      projectName: 'test', projectDir: tmpDir, stateDir, port: 0,
      sessions: {} as Record<string, never>, scheduler: {} as Record<string, never>,
    },
    sessionManager: {
      listRunningSessions: () => [],
      spawnInteractiveSession: async (_m: unknown, name: string) => { h.order.push('raw-spawn'); return `raw-${name}`; },
    },
    state: { getJobState: () => null, getSession: () => null },
    telegram: opts.noTelegram ? null : telegram,
    slack: null,
    startTime: new Date(),
    verifyDashboardOperatorSession: (proof: string | undefined) => !!opts.operatorProof && proof === opts.operatorProof,
    topicProfile: {
      store, resolver, surface,
      confirmSlots: new ProfileConfirmSlots({ ttlMs: () => 300_000 }),
      newTopicDefault: new NewTopicDefaultStore(stateDir),
      audit: (e: Record<string, unknown>) => { h.audits.push(e); },
      discloseCreationSeed: async (key: string, text: string) => { h.disclosures.push({ key, text }); },
      spawnForTopic: createSpawnForTopic({ guard: () => (opts.guardUnwired ? null : h.guard), telegram: () => telegram, spawn: spawnDep }),
      ...(opts.seam ? { sessionPoolLocalClaim: opts.seam } : {}),
    },
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  h.app = app;
  return h;
}

/** A pool seam whose ready ops record into the harness order. */
function poolSeam(h: () => Harness, o: { holds?: boolean; replication?: boolean; placeOk?: boolean } = {}) {
  const log: string[] = [];
  const seam = () => evaluateSessionPoolLocalClaim({
    routerLive: () => true,
    replicationOn: o.replication ?? true,
    holdsLease: () => o.holds ?? true,
    holder: () => ({ machineId: 'm-laptop', nickname: 'Laptop' }),
    ops: {
      place: (sk) => { log.push(`place:${sk}`); h().order.push('place'); return o.placeOk === false ? { ok: false, reason: 'not-released' } : { ok: true }; },
      confirm: (sk) => { log.push(`confirm:${sk}`); h().order.push('confirm'); return true; },
      release: (sk) => { log.push(`release:${sk}`); h().order.push('release'); return true; },
    },
  });
  return { seam, log };
}

const create = (h: Harness, body: Record<string, unknown>, intent = true) => {
  const r = request(h.app).post('/sessions/create');
  return (intent ? r.set('X-Instar-Request', '1') : r).send(body);
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-door-model-int-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/dashboard-door-model-routes:cleanup' });
});

describe('GET /topic-profile/options', () => {
  it('200 with the inventory, regime and newTopicDefault; not captured as a topic key', async () => {
    const h = build({ bins: { 'claude-code': PRESENT, 'codex-cli': MISSING } });
    const r = await request(h.app).get('/topic-profile/options').expect(200);
    expect(r.body.regime).toBe('fully-live');
    expect(r.body.doors.map((d: { framework: string }) => d.framework)).toContain('codex-cli');
    const codex = r.body.doors.find((d: { framework: string }) => d.framework === 'codex-cli');
    expect(codex).toMatchObject({ availability: 'unavailable', selectable: false, chatOnly: true });
    expect(r.body.newTopicDefault).toMatchObject({ framework: null, replication: 'local-only', seedsSinceBoot: 0 });
    expect(r.body.topicId).toBeUndefined();
  });
});

describe('POST /topic-profile/new-topic-default', () => {
  it('Bearer + intent header ⇒ 200, persisted, audited with viaOperatorSession; NO attention item', async () => {
    const h = build({ operatorProof: 'op-proof' });
    const r = await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli', model: 'gpt-6-astra' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, replication: 'local-only', newTopicDefault: { framework: 'codex-cli', model: 'gpt-6-astra', updatedBy: 'api-token' } });
    expect(new NewTopicDefaultStore(stateDir).read()?.framework).toBe('codex-cli');
    expect(h.audits.at(-1)).toMatchObject({ type: 'new-topic-default', topicKey: '*new-topic-default*', principal: 'api-token', viaOperatorSession: false, old: null, new: { framework: 'codex-cli', model: 'gpt-6-astra' } });
    await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1').set('X-Instar-Operator-Session', 'op-proof')
      .send({ framework: 'claude-code' }).expect(200);
    expect(h.audits.at(-1)).toMatchObject({ viaOperatorSession: true, old: { framework: 'codex-cli', model: 'gpt-6-astra' } });
    expect(h.attentionItems).toEqual([]);
    const opt = await request(h.app).get('/topic-profile/options').expect(200);
    expect(opt.body.newTopicDefault).toMatchObject({ framework: 'claude-code', model: null });
  });

  it('missing intent header ⇒ 403; invalid model ⇒ 400; unavailable door ⇒ 400 with the divergence code', async () => {
    const h = build({ bins: { 'claude-code': PRESENT, 'codex-cli': MISSING } });
    await request(h.app).post('/topic-profile/new-topic-default').send({ framework: 'claude-code' }).expect(403);
    const bad = await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1')
      .send({ framework: 'claude-code', model: 'gpt-6-astra' }).expect(400);
    expect(bad.body.code).toBe('invalid-model');
    const un = await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli' }).expect(400);
    expect(un.body).toMatchObject({ code: 'dashboard-unavailable-door', chatPinAllowed: true });
    expect(new NewTopicDefaultStore(stateDir).read()).toBeNull();
  });

  it('{clear:true} deletes the record and audits old → null', async () => {
    const h = build();
    await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1').send({ framework: 'codex-cli' }).expect(200);
    await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1').send({ clear: true }).expect(200);
    expect(new NewTopicDefaultStore(stateDir).read()).toBeNull();
    expect(h.audits.at(-1)).toMatchObject({ old: { framework: 'codex-cli' }, new: null });
  });

  it('rate-limited to 5/min', async () => {
    const h = build();
    for (let i = 0; i < 5; i++) {
      await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1').send({ framework: 'claude-code' }).expect(200);
    }
    await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1').send({ framework: 'claude-code' }).expect(429);
  });
});

describe('POST /sessions/create — door + model', () => {
  it('explicit pick: seeded BEFORE spawn, spawn carries the resolved profile, disclosure sent, adapter registration, no raw registry write', async () => {
    const h = build();
    const r = await create(h, { name: 'new work', platform: 'telegram', framework: 'codex-cli', model: 'gpt-6-astra' }).expect(201);
    expect(r.body).toMatchObject({
      ok: true, topicId: 901, session: 'tmux-901',
      profile: { framework: 'codex-cli', model: 'gpt-6-astra', source: { framework: 'profile-pin', model: 'profile-pin' } },
      seed: { outcome: 'seeded' }, switchableAfterFirstMessage: true,
    });
    expect(h.spawns[0].pinAtSpawn).toMatchObject({ framework: 'codex-cli', model: 'gpt-6-astra', updatedBy: 'system:dashboard-create' });
    expect(h.spawns[0].opts).toEqual({ telegramTopicId: 901, framework: 'codex-cli', defaultModel: 'gpt-6-astra' });
    expect(h.disclosures).toEqual([{ key: '901', text: 'This topic starts on Codex CLI · gpt-6-astra — chosen at creation' }]);
    expect(h.registered).toEqual([[901, 'tmux-901', 'new work']]);
    expect(fs.existsSync(path.join(stateDir, 'topic-session-registry.json'))).toBe(false);
    expect(h.guard.has(901)).toBe(false);
  });

  it('no pick + default set ⇒ seeded with system:new-topic-default and counted', async () => {
    const h = build();
    new NewTopicDefaultStore(stateDir).write({ framework: 'codex-cli', model: null, updatedAt: 't', updatedBy: 'api-token' });
    const r = await create(h, { name: 'defaulted', platform: 'telegram' }, false).expect(201);
    expect(r.body.profile.framework).toBe('codex-cli');
    expect(h.store.resolve(String(r.body.topicId))?.updatedBy).toBe('system:new-topic-default');
    const opt = await request(h.app).get('/topic-profile/options').expect(200);
    expect(opt.body.newTopicDefault.seedsSinceBoot).toBe(1);
  });

  it('no default + no pick ⇒ no seed, no audit row, spawn carries no profile-derived options', async () => {
    const h = build();
    const r = await create(h, { name: 'plain', platform: 'telegram' }, false).expect(201);
    expect(r.body.seed).toBeNull();
    expect(h.store.get(String(r.body.topicId))).toBeNull();
    expect(h.audits).toEqual([]);
    expect(h.disclosures).toEqual([]);
    expect(h.spawns[0].opts).toEqual({ telegramTopicId: r.body.topicId, framework: 'claude-code' });
    expect(r.body.profile.source).toMatchObject({ framework: 'global-default', model: 'account-default' });
  });

  it('missing intent header with a pick ⇒ 403; headless/slack + pick ⇒ 400; nothing created', async () => {
    const h = build();
    await create(h, { name: 'x', platform: 'telegram', framework: 'codex-cli' }, false).expect(403);
    await create(h, { name: 'x', platform: 'headless', framework: 'codex-cli' }).expect(400);
    await create(h, { name: 'x', platform: 'slack', model: 'gpt-6-astra', framework: 'codex-cli' }).expect(400);
    expect(h.created).toEqual([]);
  });

  it('reused topic with a pick ⇒ 409 topic-exists, no seed; without a pick the reuse proceeds unseeded', async () => {
    const h = build();
    new NewTopicDefaultStore(stateDir).write({ framework: 'codex-cli', model: null, updatedAt: 't', updatedBy: 'api-token' });
    const r = await create(h, { name: 'existing', platform: 'telegram', framework: 'codex-cli' }).expect(409);
    expect(r.body.code).toBe('topic-exists');
    expect(h.store.get('42')).toBeNull();
    const ok = await create(h, { name: 'existing', platform: 'telegram' }, false).expect(201);
    expect(ok.body.reused).toBe(true);
    expect(h.store.get('42')).toBeNull();
  });

  it('a pick on a server with no Telegram adapter ⇒ 400, never a headless session that drops the choice', async () => {
    const h = build({ noTelegram: true });
    const r = await create(h, { name: 'x', platform: 'telegram', framework: 'codex-cli' }).expect(400);
    expect(r.body.code).toBe('preference-needs-telegram');
    expect(h.order).toEqual([]);
  });

  it('Telegram failure with a pick ⇒ 502, no spawn at all (no headless fallback)', async () => {
    const h = build({ topicCreateFails: true });
    const r = await create(h, { name: 'x', platform: 'telegram', framework: 'codex-cli' }).expect(502);
    expect(r.body.step).toBe('create-topic');
    expect(h.order).toEqual([]);
  });

  it('a topic already mid-spawn ⇒ 409 topic-spawning, never a second session; the seed stays', async () => {
    const h = build();
    h.guard.add(901);
    const r = await create(h, { name: 'racing', platform: 'telegram', framework: 'codex-cli' }).expect(409);
    expect(r.body).toMatchObject({ code: 'topic-spawning', pinRetained: true });
    expect(h.spawns).toEqual([]);
    expect(h.store.resolve('901')?.framework).toBe('codex-cli');
  });

  it('spawn throws after the seed ⇒ 500 naming the step, pin retained', async () => {
    const h = build({ spawnThrows: true });
    const r = await create(h, { name: 'broken', platform: 'telegram', framework: 'codex-cli' }).expect(500);
    expect(r.body).toMatchObject({ step: 'spawn', pinRetained: true, topicId: 901 });
    expect(h.store.resolve('901')?.framework).toBe('codex-cli');
    expect(h.guard.has(901)).toBe(false);
  });

  it('the intentional divergence: the SAME unavailable pair is accepted by POST /topic-profile/:id and refused by all three dashboard writes', async () => {
    const h = build({ bins: { 'claude-code': PRESENT, 'codex-cli': MISSING }, boundOperator: true });
    const chat = await request(h.app).post('/topic-profile/555').set('X-Instar-Request', '1').send({ framework: 'codex-cli' }).expect(200);
    expect(chat.body.ok).toBe(true);
    const copy = 'Codex CLI isn\'t installed on this machine — you can still pin it in chat and it will fall back with a notice';
    const created = await create(h, { name: 'x', platform: 'telegram', framework: 'codex-cli' }).expect(400);
    expect(created.body).toEqual({ ok: false, code: 'dashboard-unavailable-door', error: copy, chatPinAllowed: true });
    const def = await request(h.app).post('/topic-profile/new-topic-default').set('X-Instar-Request', '1').send({ framework: 'codex-cli' }).expect(400);
    expect(def.body).toEqual({ ok: false, code: 'dashboard-unavailable-door', error: copy, chatPinAllowed: true });
    const opt = await request(h.app).get('/topic-profile/options').expect(200);
    expect(opt.body.doors.find((d: { framework: string }) => d.framework === 'codex-cli')).toMatchObject({ selectable: false, reason: copy });
    // The chat-accepted pin then falls back at spawn with the notice.
    expect(h.resolver.resolve('555').notices.join(' ')).toContain('isn\'t launchable here');
  });

  it('a door that cannot launch at spawn time ⇒ the resolver fallback notice reaches the topic', async () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const codexBin = path.join(binDir, 'codex');
    fs.writeFileSync(codexBin, '');
    const orig = Date.now;
    // Validation sees the binary (verified); inside the spawn it is gone and the
    // probe cache has expired — the pin falls back with the resolver's notice.
    const h = build({
      bins: { 'claude-code': PRESENT, 'codex-cli': codexBin },
      beforeSpawn: () => { SafeFsExecutor.safeUnlinkSync(codexBin, { operation: 'tests/integration/dashboard-door-model-routes:vanish-binary' }); Date.now = () => orig() + 61_000; },
    });
    try {
      const r = await create(h, { name: 'vanishing', platform: 'telegram', framework: 'codex-cli' }).expect(201);
      expect(r.body.profile.framework).toBe('claude-code');
      expect(h.store.resolve(String(r.body.topicId))?.framework).toBe('codex-cli');
      expect(h.sent.map(s => s.text).join(' ')).toContain('isn\'t launchable here');
    } finally {
      Date.now = orig;
    }
  });
});

describe('POST /sessions/create — pool seam (§3.3 2b)', () => {
  it('ready: place before seed, confirm after spawn', async () => {
    let h!: Harness;
    const { seam } = poolSeam(() => h);
    h = build({ seam });
    await create(h, { name: 'pooled', platform: 'telegram', framework: 'codex-cli' }).expect(201);
    expect(h.order).toEqual(['create-topic', 'place', 'spawn', 'confirm']);
    expect(h.audits[0]).toMatchObject({ type: 'creation-seed', outcome: 'seeded' });
  });

  it('ready + spawn throws ⇒ release, 500 names the step', async () => {
    let h!: Harness;
    const { seam } = poolSeam(() => h);
    h = build({ seam, spawnThrows: true });
    const r = await create(h, { name: 'pooled', platform: 'telegram', framework: 'codex-cli' }).expect(500);
    expect(r.body).toMatchObject({ step: 'spawn', placement: 'released' });
    expect(h.order).toEqual(['create-topic', 'place', 'spawn', 'release']);
  });

  it('ready + registration fails after the spawn returned ⇒ confirm (never release) and report', async () => {
    let h!: Harness;
    const { seam } = poolSeam(() => h);
    h = build({ seam, registerThrows: true });
    const r = await create(h, { name: 'pooled', platform: 'telegram', framework: 'codex-cli' }).expect(500);
    expect(r.body).toMatchObject({ step: 'register', placement: 'confirmed', session: 'tmux-901' });
    expect(h.order).toEqual(['create-topic', 'place', 'spawn', 'confirm']);
  });

  it('ready + the spawn guard is not wired ⇒ release (nothing was spawned), 409 names it', async () => {
    let h!: Harness;
    const { seam } = poolSeam(() => h);
    h = build({ seam, guardUnwired: true });
    const r = await create(h, { name: 'pooled', platform: 'telegram', framework: 'codex-cli' }).expect(409);
    expect(r.body).toMatchObject({ code: 'telegram-routing-not-wired', placement: 'released' });
    expect(h.order).toEqual(['create-topic', 'place', 'release']);
  });

  it('ready + a topic already mid-spawn ⇒ confirm (a local spawn is underway), never release', async () => {
    let h!: Harness;
    const { seam } = poolSeam(() => h);
    h = build({ seam });
    h.guard.add(901);
    const r = await create(h, { name: 'pooled', platform: 'telegram', framework: 'codex-cli' }).expect(409);
    expect(r.body).toMatchObject({ code: 'topic-spawning', placement: 'confirmed' });
    expect(h.order).toEqual(['create-topic', 'place', 'confirm']);
  });

  it('refused place ⇒ 409 topic-owned-elsewhere, no seed, no spawn', async () => {
    let h!: Harness;
    const { seam } = poolSeam(() => h, { placeOk: false });
    h = build({ seam });
    const r = await create(h, { name: 'pooled', platform: 'telegram', framework: 'codex-cli' }).expect(409);
    expect(r.body.code).toBe('topic-owned-elsewhere');
    expect(h.store.get('901')).toBeNull();
    expect(h.order).toEqual(['create-topic', 'place']);
  });

  it.each([
    [{ holds: false }, 'non-holder'],
    [{ replication: false }, 'replication-off'],
  ])('%s (%s) ⇒ 409 placement-not-authoritative-here naming the holder, with or without a pick, before any topic is created', async (o) => {
    let h!: Harness;
    const { seam } = poolSeam(() => h, o);
    h = build({ seam });
    const withPick = await create(h, { name: 'a', platform: 'telegram', framework: 'codex-cli' }).expect(409);
    expect(withPick.body).toMatchObject({ code: 'placement-not-authoritative-here', holderNickname: 'Laptop', holderMachineId: 'm-laptop' });
    expect(withPick.body.error).toContain('New topics are placed by Laptop right now');
    const noPick = await create(h, { name: 'b', platform: 'telegram' }, false).expect(409);
    expect(noPick.body.code).toBe('placement-not-authoritative-here');
    expect(h.created).toEqual([]);
    expect(h.order).toEqual([]);
  });
});
