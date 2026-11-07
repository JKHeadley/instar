/**
 * Integration: a New session with its own native app conversation, through the real create route
 * (docs/specs/session-conversation-for-every-session.md §2.1, §2.2). A real profile store, resolver and
 * write surface; the app conversation service and the session start are stand-ins that record calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface, type ProfileWriteRegime } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let stateDir: string;

// The SHIPPED FLEET default config (§11 — pinned: enabled:false AND dryRun:true).
const FLEET_REGIME: ProfileWriteRegime = { enabled: false, dryRun: true };

interface Bundle {
  store: TopicProfileStore;
  resolver: TopicProfileResolver;
  surface: TopicProfileWriteSurface;
  confirmSlots: ProfileConfirmSlots;
  respawns: string[];
  disclosures: Array<{ topic: string; text: string }>;
}

function buildBundle(regime: ProfileWriteRegime, opts: { boundOperator?: boolean; tokenMayWrite?: (k: string) => { ok: true } | { ok: false; reply: string } } = {}): Bundle {
  const store = new TopicProfileStore({
    stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
    legacyFrameworksPath: path.join(stateDir, 'state', 'topic-frameworks.json'),
    isDryRun: () => regime.dryRun,
  });
  const resolver = new TopicProfileResolver({
    store,
    defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}),
    configProfileDefaults: () => ({}),
    frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined,
    localModelBinding: () => null,
    frameworkBinaryPath: () => null,
  });
  const respawns: string[] = [];
  const disclosures: Array<{ topic: string; text: string }> = [];
  const surface = new TopicProfileWriteSurface({
    store,
    resolver,
    regime: () => regime,
    // Telegram topics only, as in production: app and Slack keys never have a bound operator.
    boundOperator: (k) =>
      opts.boundOperator === false || !/^\d+$/.test(k) ? null : { platform: 'telegram', uid: '777' },
    ...(opts.tokenMayWrite ? { tokenMayWrite: opts.tokenMayWrite } : {}),
    localModelBinding: () => null,
    legacyFrameworkRespawn: async (k) => { respawns.push(k); return { respawned: true }; },
    disclose: async (topic, text) => { disclosures.push({ topic, text }); },
    audit: () => 'seq-test',
  });
  const confirmSlots = new ProfileConfirmSlots({ ttlMs: () => 300_000 });
  return { store, resolver, surface, confirmSlots, respawns, disclosures };
}

function buildApp(bundle: Bundle | null, extra: Record<string, unknown> = {}, tpExtra: Record<string, unknown> = {}): express.Express {
  const ctx = {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      sessions: {} as Record<string, never>,
      scheduler: {} as Record<string, never>,
    },
    sessionManager: { listRunningSessions: () => [], spawnInteractiveSession: async () => 'term-session' },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    feedbackAnomalyDetector: null,
    discoveryEvaluator: null,
    topicProfile: bundle
      ? { store: bundle.store, resolver: bundle.resolver, surface: bundle.surface, confirmSlots: bundle.confirmSlots, ...tpExtra }
      : null,
    startTime: new Date(),
    ...extra,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-any-routes-test-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/session-swap-any-conversation.test.ts' });
});


interface Svc { creates: Array<{ key: string; title: string }>; owner: boolean }
/** The request store's contract, in memory (the real one, MobileChatRequestStore, is a JSON file; see the restart test). */
function memoryRequests() {
  const rows = new Map<string, { hash: string; state: 'pending' | 'done' | 'unknown'; result?: { status: number; body: Record<string, unknown> } }>();
  return {
    lookup: (d: string, r: string, hash: string) => {
      const x = rows.get(`${d}|${r}`);
      if (!x) return { kind: 'none' };
      if (x.hash !== hash) return { kind: 'request-id-reused' };
      if (x.state === 'done') return { kind: 'done', ...x.result! };
      return { kind: x.state === 'pending' ? 'in-progress' : 'outcome-unknown' };
    },
    reserve: (d: string, r: string, hash: string) => { rows.set(`${d}|${r}`, { hash, state: 'pending' }); return { kind: 'reserved' }; },
    finish: (d: string, r: string, result: { status: number; body: Record<string, unknown> }) => { rows.set(`${d}|${r}`, { ...rows.get(`${d}|${r}`)!, state: 'done', result }); return true; },
    markUnknown: (d: string, r: string) => { rows.set(`${d}|${r}`, { ...rows.get(`${d}|${r}`)!, state: 'unknown' }); },
    release: (d: string, r: string) => { rows.delete(`${d}|${r}`); },
  };
}
const rid = () => `${Date.now()}-${'0f9c1d2e-3b4a-4c5d-8e6f-' + Math.floor(Math.random() * 1e12).toString(16).padStart(12, '0')}`;
function appSvc(owner = true): Svc & Record<string, unknown> {
  const svc: Svc & Record<string, unknown> = { creates: [], owner, deps: { requests: memoryRequests() } };
  svc.isOwner = () => svc.owner;
  svc.applyCreate = (_d: string, _r: string, key: string, title: string) => { svc.creates.push({ key, title }); return { status: 200, body: { conversationKey: key, title } }; };
  return svc;
}

describe('POST /sessions/create — an Instar app conversation', () => {
  it('creates the conversation, seeds its engine, starts its session, and answers the key', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    const svc = appSvc();
    const starts: Array<{ key: string; name?: string }> = [];
    const app = buildApp(bundle, { appConversations: svc }, { startAppSession: async (key: string, name?: string) => { starts.push({ key, name }); return { session: 'echo-plans', refusal: null }; }, appSessionReady: () => ({ ready: true }) });
    const res = await request(app).post('/sessions/create').set('X-Instar-Request', '1').send({ name: 'Plans', platform: 'app', framework: 'codex-cli' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ ok: true, started: true, platform: 'app', session: 'echo-plans', name: 'Plans' });
    const key = res.body.conversationKey as string;
    expect(svc.creates).toEqual([{ key, title: 'Plans' }]);
    // Never named after the session: a taken name would reuse another session (SessionManager reuses by slug).
    expect(starts).toEqual([{ key, name: undefined }]);
    expect(bundle.store.resolve(`app:${key}`)?.framework).toBe('codex-cli');
    // No Telegram notice is attempted for an app key.
    expect(bundle.disclosures).toEqual([]);
  });
  it('with no Telegram or Slack, the automatic choice is an app conversation', async () => {
    const svc = appSvc();
    const app = buildApp(buildBundle(FLEET_REGIME), { appConversations: svc }, { startAppSession: async () => ({ session: 's', refusal: null }), appSessionReady: () => ({ ready: true }) });
    const res = await request(app).post('/sessions/create').send({ name: 'Quick' });
    expect(res.status).toBe(201);
    expect(res.body.platform).toBe('app');
    // Terminal-only stays available when asked for.
    expect((await request(app).post('/sessions/create').send({ name: 'Term', headless: true })).body.platform).toBe('headless');
  });
  it('a standby creates the conversation and leaves the session to the serving machine, in words', async () => {
    const svc = appSvc(false);
    let started = 0;
    const app = buildApp(buildBundle(FLEET_REGIME), { appConversations: svc }, { startAppSession: async () => { started++; return { session: 's', refusal: null }; }, appSessionReady: () => ({ ready: true }) });
    const res = await request(app).post('/sessions/create').send({ name: 'Plans', platform: 'app' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ started: false, refusal: 'not-served' });
    expect(res.body.message).toContain('Another of your machines');
    expect(svc.creates).toHaveLength(1);
    expect(started).toBe(0);
    // An engine pick made here would be lost (the serving machine never reads this store): refused first.
    const pick = await request(app).post('/sessions/create').set('X-Instar-Request', '1').send({ name: 'Other', platform: 'app', framework: 'codex-cli' });
    expect(pick.body.code).toBe('engine-choice-needs-serving-machine');
    expect(svc.creates).toHaveLength(1);
  });
  it('concurrent repeats of one request id make one conversation', async () => {
    const svc = appSvc();
    const app = buildApp(buildBundle(FLEET_REGIME), { appConversations: svc }, { startAppSession: async () => { await new Promise((r) => setTimeout(r, 50)); return { session: 's', refusal: null }; }, appSessionReady: () => ({ ready: true }) });
    const id = rid();
    const [a, b] = await Promise.all([
      request(app).post('/sessions/create').send({ name: 'Plans', platform: 'app', requestId: id }),
      request(app).post('/sessions/create').send({ name: 'Plans', platform: 'app', requestId: id }),
    ]);
    expect(a.body.conversationKey).toBe(b.body.conversationKey);
    expect(svc.creates).toHaveLength(1);
  });
  it('a refused conversation create is said in words, and a retry with the same id runs again', async () => {
    const svc = appSvc();
    const real = svc.applyCreate as (...a: unknown[]) => { status: number; body: Record<string, unknown> };
    svc.applyCreate = () => ({ status: 503, body: { error: 'conversation-recording-disabled', detail: 'Conversation recording is turned off on this agent.' } });
    const app = buildApp(buildBundle(FLEET_REGIME), { appConversations: svc }, { startAppSession: async () => ({ session: 's', refusal: null }), appSessionReady: () => ({ ready: true }) });
    const id = rid();
    const res = await request(app).post('/sessions/create').send({ name: 'Plans', platform: 'app', requestId: id });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'conversation-recording-disabled', error: 'Conversation recording is turned off on this agent.' });
    // Recording turned back on: the same id creates, rather than replaying the refusal.
    svc.applyCreate = real;
    const again = await request(app).post('/sessions/create').send({ name: 'Plans', platform: 'app', requestId: id });
    expect(again.status).toBe(201);
    expect(svc.creates).toHaveLength(1);
  });
  it('a retry after a restart finds the first create in the real request store and resumes it', async () => {
    const { MobileChatRequestStore } = await import('../../src/core/MobileChatRequests.js');
    const storeDir = path.join(stateDir, 'req');
    fs.mkdirSync(storeDir, { recursive: true });
    const id = rid();
    const first = appSvc();
    (first as { deps: unknown }).deps = { requests: new MobileChatRequestStore(storeDir) };
    const one = await request(buildApp(buildBundle(FLEET_REGIME), { appConversations: first }, { startAppSession: async () => ({ session: 's', refusal: null }), appSessionReady: () => ({ ready: true }) }))
      .post('/sessions/create').send({ name: 'Plans', platform: 'app', requestId: id });
    expect(one.status).toBe(201);
    // A new process: a fresh store instance over the same file, a fresh route (no in-memory state).
    const second = appSvc();
    (second as { deps: unknown }).deps = { requests: new MobileChatRequestStore(storeDir) };
    const two = await request(buildApp(buildBundle(FLEET_REGIME), { appConversations: second }, { startAppSession: async () => ({ session: 's', refusal: null }), appSessionReady: () => ({ ready: true }) }))
      .post('/sessions/create').send({ name: 'Plans', platform: 'app', requestId: id });
    expect(two.status).toBe(201);
    expect(two.body.conversationKey).toBe(one.body.conversationKey);
    expect(second.creates).toHaveLength(0);
    // The same id with a different engine pick is a different request.
    const three = await request(buildApp(buildBundle(FLEET_REGIME), { appConversations: second }, { startAppSession: async () => ({ session: 's', refusal: null }), appSessionReady: () => ({ ready: true }) }))
      .post('/sessions/create').set('X-Instar-Request', '1').send({ name: 'Plans', platform: 'app', requestId: id, framework: 'codex-cli' });
    expect(three.body.code).toBe('request-id-reused');
  });
  it('a start that was refused says why, and the conversation stays', async () => {
    const svc = appSvc();
    const app = buildApp(buildBundle(FLEET_REGIME), { appConversations: svc }, { startAppSession: async () => ({ session: null, refusal: 'memory' }), appSessionReady: () => ({ ready: true }) });
    const res = await request(app).post('/sessions/create').send({ name: 'Plans', platform: 'app' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ started: false, refusal: 'memory' });
    expect(res.body.message).toContain('private memory');
    expect(svc.creates).toHaveLength(1);
  });
  it('a repeated request id answers the first create, with one conversation', async () => {
    const svc = appSvc();
    const app = buildApp(buildBundle(FLEET_REGIME), { appConversations: svc }, { startAppSession: async () => ({ session: 's', refusal: null }), appSessionReady: () => ({ ready: true }) });
    const id = rid();
    const one = await request(app).post('/sessions/create').send({ name: 'Plans', platform: 'app', requestId: id });
    // A later retry (even after a restart: the record is durable in production) resumes the first create.
    const two = await request(app).post('/sessions/create').send({ name: 'Plans', platform: 'app', requestId: id });
    expect(two.body.conversationKey).toBe(one.body.conversationKey);
    expect(svc.creates).toHaveLength(1);
  });
  it('refused before anything is created: a bad name, an unready relay, app conversations off, a machine pick', async () => {
    const svc = appSvc();
    const tpx = { startAppSession: async () => ({ session: 's', refusal: null }), appSessionReady: () => ({ ready: true }) };
    const app = buildApp(buildBundle(FLEET_REGIME), { appConversations: svc }, tpx);
    expect((await request(app).post('/sessions/create').send({ name: '[]()', platform: 'app' })).body.code).toBe('bad-conversation-name');
    const notReady = buildApp(buildBundle(FLEET_REGIME), { appConversations: svc }, { ...tpx, appSessionReady: () => ({ ready: false, reason: 'old' }) });
    expect((await request(notReady).post('/sessions/create').send({ name: 'Plans', platform: 'app' })).body.code).toBe('app-relay-not-ready');
    const off = buildApp(buildBundle(FLEET_REGIME), {}, {});
    expect((await request(off).post('/sessions/create').send({ name: 'Plans', platform: 'app' })).body.code).toBe('app-conversations-unavailable');
    expect((await request(app).post('/sessions/create').set('X-Instar-Request', '1').send({ name: 'Plans', platform: 'app', machine: 'm_b' })).status).toBe(400);
    expect(svc.creates).toHaveLength(0);
  });
});
