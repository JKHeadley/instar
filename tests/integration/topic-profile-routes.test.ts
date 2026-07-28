/**
 * Integration tests — Topic Profile HTTP routes (TOPIC-PROFILE-SPEC §10.1/§12).
 *
 * Full HTTP pipeline over a REAL TopicProfileStore + resolver + write surface:
 *   - GET  /topic-profile/:topicId            — resolved profile + pin + parked + shadow
 *   - POST /topic-profile/:topicId            — TOKEN-TRUST write (Bearer + X-Instar-Request);
 *                                               body-supplied updatedBy is overridden;
 *                                               refuses topics with no bound operator;
 *                                               §5.2(d) framework writes land LIVE under the
 *                                               shipped fleet config; new axes refuse/shadow.
 *   - POST /topic-profile/:topicId/undo|clear|reapply — recovery surfaces.
 *   - 503 when the profile bundle is not wired; key clamp at the route boundary.
 *   - persistence survives a store reload (a second store instance reads the pin).
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

function buildBundle(regime: ProfileWriteRegime, opts: { boundOperator?: boolean } = {}): Bundle {
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
    boundOperator: () =>
      opts.boundOperator === false ? null : { platform: 'telegram', uid: '777' },
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-profile-routes-test-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/topic-profile-routes.test.ts',
  });
});

describe('GET /topic-profile/:topicId', () => {
  it('returns the resolved profile + entry state (200)', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    await bundle.store.mutate(23, { framework: 'codex-cli', updatedBy: 'telegram:777' });
    const app = buildApp(bundle);
    const res = await request(app).get('/topic-profile/23');
    expect(res.status).toBe(200);
    expect(res.body.resolved.framework).toBe('codex-cli');
    expect(res.body.pin.framework).toBe('codex-cli');
    expect(res.body.pin.updatedBy).toBe('telegram:777');
    expect(res.body.breakerCount).toBe(0);
  });

  it('503 when the profile bundle is not wired (feature-is-alive boundary)', async () => {
    const app = buildApp(null);
    const res = await request(app).get('/topic-profile/23');
    expect(res.status).toBe(503);
  });

  it('clamps the topic key at the route boundary (§12.5)', async () => {
    const app = buildApp(buildBundle(FLEET_REGIME));
    // Path traversal never reaches the handler (Express normalizes → 404).
    expect([400, 404]).toContain((await request(app).get('/topic-profile/../etc')).status);
    expect((await request(app).get('/topic-profile/abc;rm')).status).toBe(400);
    expect((await request(app).get('/topic-profile/slack:C123:1718.42')).status).toBe(200);
  });
});

describe('POST /topic-profile/:topicId (token-trust write)', () => {
  it('requires the X-Instar-Request intent header (403 without)', async () => {
    const app = buildApp(buildBundle(FLEET_REGIME));
    const res = await request(app).post('/topic-profile/23').send({ framework: 'codex-cli' });
    expect(res.status).toBe(403);
  });

  it('§5.2(d): a framework write lands LIVE + legacy respawn under the SHIPPED fleet config', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    const app = buildApp(bundle);
    const res = await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli' });
    expect(res.status).toBe(200);
    expect(res.body.appliedLive).toContain('framework');
    expect(res.body.shadowed).toEqual([]);
    expect(bundle.store.resolve(23)?.framework).toBe('codex-cli');
    expect(bundle.store.get(23)?.intendedProfile).toBeNull();
    expect(bundle.respawns).toEqual(['23']);
    // §8: a token-trust write still discloses to the topic, origin named
    expect(bundle.disclosures.length).toBe(1);
    expect(bundle.disclosures[0].text).toContain('via API');
    // persistence survives reload — a SECOND store instance reads the pin
    const reloaded = new TopicProfileStore({
      stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
    });
    expect(reloaded.resolve(23)?.framework).toBe('codex-cli');
  });

  it('a body-supplied updatedBy is OVERRIDDEN — token writes stamp api-token (§10.1)', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    const app = buildApp(bundle);
    const res = await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli', updatedBy: 'telegram:999-forged' });
    expect(res.status).toBe(200);
    expect(bundle.store.resolve(23)?.updatedBy).toBe('api-token');
  });

  it('refuses a write to a topic with no bound operator (403)', async () => {
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
    const app = buildApp(bundle);
    const res = await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli' });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('no-bound-operator');
    expect(bundle.store.resolve(23)).toBeNull();
  });

  it('refuses a new-axis pin while disabled (409, structured reason)', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    const app = buildApp(bundle);
    const res = await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ thinkingMode: 'high' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('disabled');
  });

  it('shadows a new-axis pin under the dev config (enabled:true + dryRun:true)', async () => {
    const bundle = buildBundle({ enabled: true, dryRun: true });
    const app = buildApp(bundle);
    const res = await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ thinkingMode: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.shadowed).toEqual(['thinkingMode']);
    expect(bundle.store.resolve(23)).toBeNull();
    expect(bundle.store.get(23)?.intendedProfile?.fields.thinkingMode).toBe('high');
  });

  it('validation refusals return a structured reason (400) and leave the profile unchanged', async () => {
    const bundle = buildBundle({ enabled: true, dryRun: false });
    const app = buildApp(bundle);
    const res = await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ model: 'evil;rm -rf /' });
    expect(res.status).toBe(400);
    expect(res.body.validation.field).toBe('model');
    expect(res.body.validation.failure).toBe('regex');
    expect(bundle.store.resolve(23)).toBeNull();
  });

  it('rejects non-string field types (400)', async () => {
    const app = buildApp(buildBundle(FLEET_REGIME));
    const res = await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ framework: 42 });
    expect(res.status).toBe(400);
  });
});

describe('recovery surfaces (§10.3 / §5.2(b))', () => {
  it('undo restores the pre-pin profile (409 when nothing to undo)', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    const app = buildApp(bundle);
    const nothing = await request(app)
      .post('/topic-profile/23/undo')
      .set('X-Instar-Request', '1');
    expect(nothing.status).toBe(409);

    await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli' });
    const undo = await request(app)
      .post('/topic-profile/23/undo')
      .set('X-Instar-Request', '1');
    expect(undo.status).toBe(200);
    expect(bundle.store.resolve(23)?.framework ?? null).toBeNull();
  });

  it('clear is a LIVE write under the shipped fleet config, no respawn fired', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    const app = buildApp(bundle);
    await request(app)
      .post('/topic-profile/23')
      .set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli' });
    bundle.respawns.length = 0;
    const res = await request(app)
      .post('/topic-profile/23/clear')
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(200);
    expect(bundle.store.resolve(23)?.framework ?? null).toBeNull();
    expect(bundle.respawns).toEqual([]); // §5.2(b): no profile-kill outside fully-live
    expect(res.body.message).toContain('next session restart');
  });

  it('reapply: 409 + needsConfirm inside the cooldown; confirm:true applies', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    await bundle.store.mutate(23, { framework: 'codex-cli', updatedBy: 'telegram:777' });
    await bundle.store.parkAndRevert(23, 'spawn-failures', null);
    const app = buildApp(bundle);

    const blocked = await request(app)
      .post('/topic-profile/23/reapply')
      .set('X-Instar-Request', '1');
    expect(blocked.status).toBe(409);
    expect(blocked.body.needsConfirm).toBe(true);

    const confirmed = await request(app)
      .post('/topic-profile/23/reapply')
      .set('X-Instar-Request', '1')
      .send({ confirm: true });
    expect(confirmed.status).toBe(200);
    expect(bundle.store.resolve(23)?.framework).toBe('codex-cli');
    expect(bundle.store.parkedFor(23)).toBeNull();
  });
});

// ── effort pin: full POST→store→GET data-flow over the HTTP pipeline ─────────
// Wiring/data-flow coverage that the resolved `effort` makes it all the way
// from a write, through the store + resolver, back out the GET read surface
// (the same `resolved.effort` the spawn path threads into the launch builder).
describe('effort pin (POST→store→GET data-flow)', () => {
  it('lands a valid effort LIVE under the fully-live regime and reads it back', async () => {
    const bundle = buildBundle({ enabled: true, dryRun: false });
    const app = buildApp(bundle);
    const write = await request(app)
      .post('/topic-profile/13481')
      .set('X-Instar-Request', '1')
      .send({ effort: 'max' });
    expect(write.status).toBe(200);
    expect(write.body.appliedLive).toContain('effort');
    expect(bundle.store.resolve(13481)?.effort).toBe('max');

    // The resolver surfaces it on the GET read — the same value the spawn path
    // threads into the launch builder as `--effort`.
    const read = await request(app).get('/topic-profile/13481');
    expect(read.status).toBe(200);
    expect(read.body.resolved.effort).toBe('max');
    expect(read.body.resolved.sources.effort).toBe('profile-pin');

    // Persistence survives a store reload (a second instance reads the pin).
    const reloaded = new TopicProfileStore({
      stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
    });
    expect(reloaded.resolve(13481)?.effort).toBe('max');
  });

  it('rejects an off-enum effort (400, profile unchanged) — ultracode is not a CLI value', async () => {
    const bundle = buildBundle({ enabled: true, dryRun: false });
    const app = buildApp(bundle);
    const res = await request(app)
      .post('/topic-profile/13481')
      .set('X-Instar-Request', '1')
      .send({ effort: 'ultracode' });
    expect(res.status).toBe(400);
    expect(res.body.validation.field).toBe('effort');
    expect(res.body.validation.failure).toBe('off-enum');
    expect(bundle.store.resolve(13481)).toBeNull();
  });

  it('GET exposes resolved.effort:null when no pin is set', async () => {
    const app = buildApp(buildBundle(FLEET_REGIME));
    const res = await request(app).get('/topic-profile/55');
    expect(res.status).toBe(200);
    expect(res.body.resolved.effort).toBeNull();
  });
});
