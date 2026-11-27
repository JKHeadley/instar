/**
 * Integration: engine and model changes for app and Slack conversations through the real HTTP routes
 * (docs/specs/session-swap-any-conversation.md §3.4, §3.5). A real TopicProfileStore, resolver and
 * write surface; the authority hook decides app and Slack token writes, never Telegram ones.
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

function buildApp(bundle: Bundle | null): express.Express {
  const ctx = {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      sessions: {} as Record<string, never>,
      scheduler: {} as Record<string, never>,
    },
    sessionManager: { listRunningSessions: () => [] },
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
      ? { store: bundle.store, resolver: bundle.resolver, surface: bundle.surface, confirmSlots: bundle.confirmSlots }
      : null,
    startTime: new Date(),
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

const APP = 'app:0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';

describe('POST /topic-profile/<app or Slack key>', () => {
  it('an app conversation served here switches live, restarts through its port, and discloses', async () => {
    const bundle = buildBundle(FLEET_REGIME, { tokenMayWrite: () => ({ ok: true }) });
    const app = buildApp(bundle);
    const res = await request(app).post(`/topic-profile/${APP}`).set('X-Instar-Request', '1').send({ framework: 'codex-cli' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.appliedLive).toContain('framework');
    expect(bundle.store.resolve(APP)?.framework).toBe('codex-cli');
    expect(bundle.respawns).toEqual([APP]);
    expect(bundle.disclosures.map((d) => d.topic)).toEqual([APP]);
    expect((await request(app).get(`/topic-profile/${APP}`)).status).toBe(200);
  });
  it('refused with the conversation\'s own words (standby machine), nothing written', async () => {
    const bundle = buildBundle(FLEET_REGIME, { tokenMayWrite: () => ({ ok: false, reply: 'Another of your machines runs this conversation right now. Switch it there, or try again in a moment.' }) });
    const app = buildApp(bundle);
    const res = await request(app).post('/topic-profile/slack:C0ABC').set('X-Instar-Request', '1').send({ framework: 'codex-cli' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('Another of your machines');
    expect(bundle.store.resolve('slack:C0ABC')).toBeNull();
    expect(bundle.respawns).toEqual([]);
  });
  it('a Telegram topic keeps its bound-operator rule; the hook is never asked', async () => {
    let asked = 0;
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false, tokenMayWrite: () => { asked++; return { ok: true }; } });
    const res = await request(buildApp(bundle)).post('/topic-profile/23').set('X-Instar-Request', '1').send({ framework: 'codex-cli' });
    expect(res.status).toBe(403);
    expect(asked).toBe(0);
  });
  it('a key that is not a conversation is refused at the route', async () => {
    const app = buildApp(buildBundle(FLEET_REGIME, { tokenMayWrite: () => ({ ok: true }) }));
    expect((await request(app).get('/topic-profile/app:nope')).status).toBe(400);
    expect((await request(app).get(`/topic-profile/${APP.toUpperCase()}`)).status).toBe(400);
  });
});
