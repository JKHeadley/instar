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
import { handleAndAcknowledgeProfileProposalReply } from '../../src/core/handleProfileProposalReply.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { notificationContext } from '../../src/messaging/NotificationSelectivityGate.js';
import { TEAM_ACCESS_DIR } from '../../src/core/TeamAccessLog.js';

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

function buildBundle(regime: ProfileWriteRegime, opts: { boundOperator?: boolean; now?: () => number; proposalTtlMs?: () => number } = {}): Bundle {
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
  const confirmSlots = new ProfileConfirmSlots({ ttlMs: () => 300_000, now: opts.now, proposalTtlMs: opts.proposalTtlMs });
  return { store, resolver, surface, confirmSlots, respawns, disclosures };
}

function buildApp(bundle: Bundle | null, extra: Record<string, unknown> = {}): express.Express {
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
    ...extra,
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

it.each([{ enabled: false, dryRun: true }, { enabled: true, dryRun: true }, { enabled: true, dryRun: false }])('persists cosmetic preferences independently of model-profile regime %j', async regime => {
  const bundle = buildBundle(regime);
  const app = buildApp(bundle);
  const result = await request(app).post('/topic-profile/42').set('X-Instar-Request', '1')
    .send({ messageOriginDisplay: { enabled: false, model: true } }).expect(200);
  expect(result.body.pin.messageOriginDisplay).toEqual({ enabled: false, model: true });
  expect(result.body.message).toContain('origin recording continues');
  expect(bundle.respawns).toEqual([]);
  expect(bundle.surface.renderReadout('42')).toContain('enabled hidden');
  expect(bundle.surface.renderProposalEcho('42', { messageOriginDisplay: { enabled: false } })).toMatchObject({ ok: true });
  const reloaded = buildBundle({ enabled: true, dryRun: false });
  expect(reloaded.store.resolve('42')?.messageOriginDisplay).toEqual({ enabled: false, model: true });
  await request(app).post('/topic-profile/42').set('X-Instar-Request', '1')
    .send({ messageOriginDisplay: { enabled: 'false' } }).expect(400);
  expect(bundle.store.resolve('42')?.messageOriginDisplay?.enabled).toBe(false);
  await request(app).post('/topic-profile/42').set('X-Instar-Request', '1')
    .send({ messageOriginDisplay: null }).expect(200);
  expect(bundle.store.resolve('42')?.messageOriginDisplay).toBeNull();
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

describe('identity-security-creation-provenance v5: propose with confirmIn', () => {
  const OWNER = 7812716706;
  function fakes(o: { sourceOperator?: number | null; destBinding?: number | null; destVerified?: boolean; fleet?: boolean } = {}) {
    const sends: Array<{ topic: number; text: string; category?: string }> = [];
    let mid = 900;
    return {
      sends,
      extra: {
        // The switch is live on a development agent (umbrella §10 per-piece switch).
        config: { projectName: 'test-project', projectDir: path.dirname(stateDir), stateDir, port: 0, sessions: {}, scheduler: {}, ...(o.fleet ? {} : { developmentAgent: true }) },
        telegram: {
          sendToTopic: async (topic: number, text: string) => { sends.push({ topic, text, category: notificationContext.getStore()?.category }); return { messageId: ++mid }; },
          getOwnerUserId: () => OWNER,
          getTopicName: (t: number) => (t === 23 ? 'Scaling' : t === 130715 ? 'Main' : null),
        },
        topicOperatorStore: {
          getOperator: (t: number | string) => {
            if (String(t) === '130715') return o.sourceOperator === null ? null : { platform: 'telegram', uid: String(o.sourceOperator ?? OWNER) };
            return o.destBinding && o.destVerified !== false ? { platform: 'telegram', uid: String(o.destBinding) } : null;
          },
          allBindings: () => [],
          everVerifiedOperatorUids: () => [],
          getBinding: (t: number | string) => (String(t) !== '130715' && o.destBinding ? { platform: 'telegram', uid: String(o.destBinding) } : null),
        },
      },
    };
  }

  it('shows an immutable hours-long deadline through HTTP and still applies after eight minutes', async () => {
    let now = Math.floor(Date.now() / 1000) * 1000;
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false, now: () => now, proposalTtlMs: () => 4 * 60 * 60_000 });
    const f = fakes(); const app = buildApp(bundle, f.extra);
    const result = await request(app).post('/topic-profile/23/propose').set('X-Instar-Request', '1').send({ framework: 'codex-cli', confirmIn: 130715 });
    expect(result.status).toBe(200); expect(result.body.expiresAt).toBe(now + 4 * 60 * 60_000);
    expect(result.body.echo).toContain('UTC');
    const question = bundle.confirmSlots.proposals.get('130715', result.body.requestId)!;
    now += 8 * 60_000;
    const outcome = await handleAndAcknowledgeProfileProposalReply({ requests: bundle.confirmSlots.proposals, surface: bundle.surface,
      source: '130715', text: 'yes', messageId: 950, replyTo: question.receipts[0].messageId, forwarded: false,
      principal: { kind: 'operator', platform: 'telegram', uid: String(OWNER) }, eligible: () => true,
      placement: () => 'standalone', name: () => 'Scaling' }, async () => {});
    expect(outcome.result?.settingsSaved).toBe(true); expect(bundle.store.resolve(23)?.framework).toBe('codex-cli');
  });

  it('reports a question delivered after its deadline as delivered but inactive, never armed or transport-failed', async () => {
    let now = 0; const bundle = buildBundle(FLEET_REGIME, { boundOperator: false, now: () => now, proposalTtlMs: () => 1000 });
    const f = fakes(); const send = f.extra.telegram.sendToTopic;
    f.extra.telegram.sendToTopic = async (...args: Parameters<typeof send>) => { const receipt = await send(...args); now = 1000; return receipt; };
    const result = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1').send({ framework: 'codex-cli', confirmIn: 130715 });
    expect(result.status).toBe(409); expect(result.body).toMatchObject({ ok: false, delivered: true, reason: 'question-no-longer-active' });
    expect(bundle.confirmSlots.proposals.list('130715')).toEqual([]); expect(bundle.store.resolve(23)).toBeNull();
  });

  it('keeps two identified proposals and sends an explicit reminder without creating another', async () => {
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
    const f = fakes(); const app = buildApp(bundle, f.extra);
    const one = await request(app).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli', confirmIn: 130715 });
    const two = await request(app).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ framework: 'claude-code', confirmIn: 130715 });
    expect(one.body.requestId).toMatch(/^R-/); expect(two.body.requestId).not.toBe(one.body.requestId);
    expect(bundle.confirmSlots.proposals.list('130715')).toHaveLength(2);
    const reminder = await request(app).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ remindRequestId: one.body.requestId, confirmIn: 130715 });
    expect(reminder.status).toBe(200); expect(reminder.body.requestId).toBe(one.body.requestId);
    expect(bundle.confirmSlots.proposals.list('130715')).toHaveLength(2);
    expect(f.sends[2].text).not.toBe(f.sends[0].text);
    expect(f.sends[2].text).toContain('Codex'); expect(f.sends[2].text).toContain('summary');
    expect(f.sends[2].text).not.toContain('framework →'); expect(bundle.store.resolve(23)).toBeNull();
  });

  it.each(['shared', 'unreadable'])('server-owned clarification hides both pending changes for a %s audience', async mode => {
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false }); const f = fakes();
    const app = buildApp(bundle, f.extra);
    const ids: string[] = [];
    for (const framework of ['codex-cli', 'claude-code']) {
      const r = await request(app).post('/topic-profile/23/propose').set('X-Instar-Request', '1').send({ framework, confirmIn: 130715 });
      expect(r.status).toBe(200); ids.push(r.body.requestId);
    }
    if (mode === 'shared') {
      const dir = path.join(stateDir, TEAM_ACCESS_DIR); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'confined.json'), JSON.stringify({ entries: [{ ref: 'telegram:130715' }] }));
    } else f.extra.topicOperatorStore.getOperator = () => { throw new Error('audience read unavailable'); };
    const r = await request(app).post('/topic-profile/130715/propose').set('X-Instar-Request', '1').send({ clarifyPending: true });
    expect(r.status).toBe(200); expect(r.body.requests).toEqual([]);
    const sent = f.sends.at(-1)!.text;
    expect(sent).toBe('Which change do you mean? Please name the change you want to make.');
    for (const privateText of ['Scaling', 'Codex', 'Claude', ...ids]) expect(sent).not.toContain(privateText);
    expect(bundle.confirmSlots.proposals.list('130715')).toHaveLength(2); expect(bundle.store.resolve(23)).toBeNull();
  });

  it('retains a real committed profile result after failed acknowledgment and duplicate inbound', async () => {
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false }); const f = fakes();
    const r = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli', confirmIn: 130715 });
    expect(r.status).toBe(200);
    const proposed = bundle.confirmSlots.proposals.get('130715', r.body.requestId)!;
    let failAck = true; let ackAttempts = 0;
    const run = () => handleAndAcknowledgeProfileProposalReply({ requests: bundle.confirmSlots.proposals, surface: bundle.surface,
      source: '130715', text: 'yes', messageId: 950, replyTo: proposed.receipts[0].messageId, forwarded: false,
      principal: { kind: 'operator', platform: 'telegram', uid: String(OWNER) }, eligible: () => true,
      placement: () => 'standalone', name: () => 'Scaling' }, async () => {
        ackAttempts++; if (failAck) throw new Error('Telegram acknowledgment unavailable');
      });
    const first = await run(); expect(first.result?.ok).toBe(true); expect(first.acknowledgment).toBe('failed');
    failAck = false;
    const duplicate = await run(); expect(duplicate.result).toEqual(first.result);
    expect(duplicate.acknowledgment).toBe('delivered'); expect(ackAttempts).toBe(2);
    expect(bundle.respawns).toEqual(['23']); expect(bundle.store.resolve(23)?.framework).toBe('codex-cli');
    const durable = new TopicProfileStore({ stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'), isDryRun: () => true });
    expect(durable.resolve(23)?.framework).toBe('codex-cli');
  });

  it.each([{ framework: 'codex-cli' }, { model: 'opus' }])('posts the exact run-setting proposal %j to the asking conversation without writing', async patch => {
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
    const f = fakes();
    const res = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ ...patch, confirmIn: 130715 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].topic).toBe(130715);
    expect(f.sends[0].category).toBe('owner-decision');
    expect(f.sends[0].text).toContain('framework' in patch ? 'Use Codex' : 'Model: opus');
    expect(f.sends[0].text).toContain('Reply to this message with yes.');
    expect(f.sends[0].text).toContain('Change how “Scaling” runs?');
    expect(bundle.confirmSlots.proposals.list('130715')[0]?.target).toBe('23');
    expect(bundle.confirmSlots.peek('23')).toBeNull();
    expect(bundle.store.resolve(23)).toBeNull(); // nothing written until the owner says yes
  });

  it('also accepts a target already verified to the same owner', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    const f = fakes({ destBinding: OWNER });
    const res = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli', confirmIn: 130715 });
    expect(res.status).toBe(200);
    expect(bundle.confirmSlots.proposals.list('130715')[0]?.patch).toEqual({ framework: 'codex-cli' });
    expect(bundle.store.resolve(23)).toBeNull();
  });

  it('refuses and arms nothing when the asker is not the owner, B is run by someone else, or B is a candidate binding; the owner hears a refusal about B', async () => {
    const cases: Array<[ReturnType<typeof fakes>, string, number]> = [
      [fakes({ sourceOperator: 7000001 }), 'source-not-owner', 0],
      [fakes({ sourceOperator: null }), 'source-not-owner', 0],
      [fakes({ destBinding: 7000001 }), 'destination-bound', 1],
      [fakes({ destBinding: OWNER, destVerified: false }), 'destination-bound', 1],
    ];
    for (const [f, reason, notices] of cases) {
      const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
      const res = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
        .send({ framework: 'codex-cli', confirmIn: 130715 });
      expect(res.status, reason).toBe(422);
      expect(res.body.refusal).toBe(reason);
      expect(f.sends, reason).toHaveLength(notices);
      if (notices) expect(f.sends[0].text).toContain("I can't change the conversation \"Scaling\" from here");
      expect(bundle.confirmSlots.proposals.list('130715')).toEqual([]);
    }
  });

  it('dark on the fleet: confirmIn is refused (503) and nothing is posted', async () => {
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
    const f = fakes({ fleet: true });
    const res = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli', confirmIn: 130715 });
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('confirmIn-dark');
    expect(f.sends).toHaveLength(0);
  });

  it('a malformed confirmIn, one naming the same conversation, or a field outside everyday run settings is a 400', async () => {
    for (const confirmIn of ['x', 0, 23]) {
      const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
      const res = await request(buildApp(bundle, fakes().extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
        .send({ model: 'opus', confirmIn });
      expect(res.status, String(confirmIn)).toBe(400);
    }
    for (const field of ['messageOriginDisplay', 'escalationOverride']) {
      const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
      const res = await request(buildApp(bundle, fakes().extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
        .send({ [field]: 'codex-cli', confirmIn: 130715 });
      expect(res.status, field).toBe(400);
    }
  });

  it.each(['source', 'destination'])('refuses a framework proposal when the %s conversation belongs to a team member', async (which) => {
    const dir = path.join(stateDir, TEAM_ACCESS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'confined.json'), JSON.stringify({ entries: [{ ref: `telegram:${which === 'source' ? 130715 : 23}` }] }));
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
    const f = fakes();
    const res = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli', confirmIn: 130715 });
    expect(res.status).toBe(422);
    expect(res.body.refusal).toBe(which === 'source' ? 'source-shared' : 'destination-confined');
    expect(bundle.confirmSlots.proposals.list('130715')).toEqual([]);
    expect(bundle.store.resolve(23)).toBeNull();
  });

  it('refuses an invalid framework before arming or sending the proposal', async () => {
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
    const f = fakes();
    const res = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ framework: 'unknown-engine', confirmIn: 130715 });
    expect(res.status).toBe(400);
    expect(f.sends).toHaveLength(0);
    expect(bundle.confirmSlots.proposals.list('130715')).toEqual([]);
  });

  it('disarms an unseen proposal when Telegram records it quiet instead of delivering it', async () => {
    const bundle = buildBundle(FLEET_REGIME, { boundOperator: false });
    const f = fakes();
    const extra = { ...f.extra, telegram: { ...f.extra.telegram, sendToTopic: async () => ({ recorded: true, delivered: false, quietId: 'budget' }) } };
    const res = await request(buildApp(bundle, extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli', confirmIn: 130715 });
    expect(res.status).toBe(502);
    expect(bundle.confirmSlots.proposals.list('130715')).toEqual([]);
    expect(bundle.store.resolve(23)).toBeNull();
  });

  it('without confirmIn the propose lane is unchanged: proposal in the same conversation, no target', async () => {
    const bundle = buildBundle(FLEET_REGIME);
    const f = fakes();
    const res = await request(buildApp(bundle, f.extra)).post('/topic-profile/23/propose').set('X-Instar-Request', '1').send({ framework: 'codex-cli' });
    expect(res.status).toBe(200);
    expect(f.sends[0].topic).toBe(23);
    expect(f.sends[0].category).toBe('owner-decision');
    expect(bundle.confirmSlots.proposals.list('23')[0]?.target).toBe('23');
  });
});

