// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Console makeover E2E (docs/specs/console-makeover.md, MVP 5): the feature is
 * alive on the production initialization path. A REAL AgentServer serves the
 * console page, and every route Home reads answers through the real auth +
 * routing stack; the shipped view-models turn those real answers into cards
 * that are either a real reading or an explicit "can't tell" — never a crash and
 * never a fabricated "fine".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  buildReach, buildNeeds, buildDoing, buildPromised, buildRunning, buildAllowed, headline,
} from '../../dashboard/console/home-model.js';
import { buildPromisesPage, actionsFor } from '../../dashboard/console/promises-model.js';
import { buildMachinesPage, healthOf } from '../../dashboard/console/machines-model.js';
import { buildAccountsPage } from '../../dashboard/console/accounts-model.js';
import { buildFeatures, buildProfile, buildHistory, buildGuards, walkToEnabled } from '../../dashboard/console/allowed-model.js';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';

describe('Console Home E2E (feature is alive)', () => {
  const AUTH = 'console-home-e2e';
  const auth = { Authorization: `Bearer ${AUTH}` };
  let tmp = '';
  let server: AgentServer;
  let tracker: CommitmentTracker;
  let features: FeatureRegistry;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-home-e2e-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'server-data'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir), originMachineId: 'e2e' });
    const config = { projectName: 'e2e', projectDir: tmp, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10_000, version: '0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, monitoring: {} } as unknown as InstarConfig;
    features = new FeatureRegistry(stateDir, { hmacKey: AUTH });
    await features.open();
    for (const def of BUILTIN_FEATURES) features.register(def);
    const autonomyManager = new AutonomyProfileManager({ stateDir, config });
    server = new AgentServer({ config, commitmentTracker: tracker, featureRegistry: features, autonomyManager,
      sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
      state: new StateManager(stateDir) });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    features.close();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/console-home-lifecycle.test.ts' });
  });

  it('serves the console page and its modules from the real server', async () => {
    const page = await request(server.getApp()).get('/dashboard/console/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('console.js');
    expect(page.headers['x-frame-options']).toBe('DENY');
    const js = await request(server.getApp()).get('/dashboard/console/home-model.js');
    expect(js.status).toBe(200);
  });

  it('the token check the console uses is a protected route, not /health', async () => {
    expect((await request(server.getApp()).get('/sessions')).status).toBe(401);
    expect((await request(server.getApp()).get('/sessions').set(auth)).status).toBe(200);
  });

  it('every Home source answers through the real stack and maps to an honest card', async () => {
    tracker.record({ userRequest: 'approve the plan', agentResponse: 'waiting for your yes', type: 'one-time-action',
      verificationMethod: 'manual', owner: 'user', blockedOn: 'user-input' } as never);

    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      return r.status === 200 ? { ok: true, data: r.body } : { ok: false, reason: `the server answered ${r.status}` };
    };
    const cards = {
      reach: buildReach(await read('/health')),
      needs: buildNeeds(await read('/attention?scope=pool')),
      doing: buildDoing(await read('/sessions?scope=pool')),
      promised: buildPromised(await read('/commitments?scope=mesh')),
      running: buildRunning(await read('/pool')),
      allowed: buildAllowed(await read('/guards'), await read('/mandate')),
    };
    const allowedStates = ['ok', 'attn', 'bad', 'unknown', 'partial', 'stale'];
    for (const [id, c] of Object.entries(cards)) {
      expect(allowedStates, id).toContain(c.state);
      expect(typeof c.value, id).toBe('string');
      // "Can't tell" always carries its reason.
      if (c.state === 'unknown') expect(c.line.length, id).toBeGreaterThan(5);
    }
    // The real commitment that waits on the operator surfaces.
    expect(cards.promised.state).toBe('attn');
    expect(cards.promised.value).toBe('1 need you');
    expect(headline(cards).text).not.toBe('All quiet.');
  });

  it('the Promises page reads the real mesh view and its Mark-as-done reaches the real tracker', async () => {
    const rec = tracker.record({ userRequest: 'send the summary', agentResponse: 'I will send it tonight', type: 'one-time-action', verificationMethod: 'manual' } as never);
    const r = await request(server.getApp()).get('/commitments?scope=mesh').set(auth);
    expect(r.status).toBe(200);
    const page = buildPromisesPage({ ok: true, data: r.body }, Date.now(), { expectedPeers: 0 });
    expect(page.ok).toBe(true);
    const row = [...page.sections.carrying, ...page.sections.dueSoon].find((x) => x.id === rec.id)!;
    expect(row).toBeTruthy();
    expect(actionsFor(row.record)).toContain('deliver');
    const d = await request(server.getApp()).post(`/commitments/${rec.id}/deliver`).set(auth).send({});
    expect(d.status).toBe(200);
    const after = await request(server.getApp()).get('/commitments?scope=mesh').set(auth);
    const page2 = buildPromisesPage({ ok: true, data: after.body }, Date.now(), { expectedPeers: 0 });
    expect(page2.sections.closed.map((x) => x.id)).toContain(rec.id);
  });

  it('the Machines page reads the real pool and health routes and shows one honest card on a single machine', async () => {
    const pool = await request(server.getApp()).get('/pool').set(auth);
    const page = buildMachinesPage(pool.status === 200 ? { ok: true, data: pool.body } : { ok: false, reason: `the server answered ${pool.status}` }, null, Date.now());
    if (pool.status === 200) {
      expect(page.ok).toBe(true);
      expect(page.machines.length).toBeGreaterThanOrEqual(1);
    } else {
      expect(page.ok).toBe(false);
      expect(page.reason).toContain(String(pool.status));
    }
    const sys = await request(server.getApp()).get('/systems/status').set(auth);
    const h = healthOf(sys.status === 200 ? { ok: true, data: sys.body } : { ok: false, reason: String(sys.status) });
    expect(typeof h.ok).toBe('boolean');
    if (!h.ok) expect(h.reason.length).toBeGreaterThan(0);
  });

  it('the Accounts page maps the real account-pool answer to a page or an honest reason', async () => {
    const r = await request(server.getApp()).get('/subscription-pool?scope=pool').set(auth);
    const page = buildAccountsPage(r.status === 200 ? { ok: true, data: r.body } : { ok: false, reason: `the server answered ${r.status}` }, Date.now());
    if (page.ok) expect(Array.isArray(page.accounts)).toBe(true);
    else expect(page.reason.length).toBeGreaterThan(10);
    // The sign-in start route refuses without a PIN; the console never sends one it did not just collect.
    const s = await request(server.getApp()).post('/subscription-pool/matrix/start-cell').set(auth).send({ accountId: 'a', machineId: 'm' });
    expect([400, 401, 403, 404, 503]).toContain(s.status);
  });

  it('the allowed page walks real features to on through the real routes and reads the real profile', async () => {
    const app = server.getApp();
    const read = async (p: string) => {
      const r = await request(app).get(p).set(auth);
      return r.status === 200 ? { ok: true, data: r.body } : { ok: false, reason: `the server answered ${r.status}` };
    };
    const deps = {
      getInfo: (id: string) => read(`/features/${id}`),
      transition: async (id: string, body: Record<string, unknown>) => {
        const r = await request(app).post(`/features/${id}/transition`).set(auth).send(body);
        return { ok: r.status === 200, status: r.status, data: r.body };
      },
      confirmChallenge: async () => true,
    };
    const list = buildFeatures(await read('/features'));
    expect(list.ok).toBe(true);
    const byId = (id: string) => list.groups.flatMap((g: { features: unknown[] }) => g.features).find((f: { id: string }) => f.id === id);

    // A fresh local-tier feature: undiscovered → enabled, no consent record.
    const local = byId('evolution-system');
    expect(local.state).toBe('undiscovered');
    expect((await walkToEnabled(local, deps)).steps).toEqual(['aware', 'interested', 'enabled']);
    // A fresh network-tier feature: the real registry refuses without consent, accepts with it.
    const net = byId('publishing-telegraph');
    const bare = await request(app).post('/features/publishing-telegraph/transition').set(auth).send({ to: 'aware' });
    expect(bare.status).toBe(200);
    await request(app).post('/features/publishing-telegraph/transition').set(auth).send({ to: 'interested' });
    const refused = await request(app).post('/features/publishing-telegraph/transition').set(auth).send({ to: 'enabled' });
    expect(refused.body.error.code).toBe('CONSENT_REQUIRED');
    const netWalk = await walkToEnabled(net, deps);
    expect(netWalk.ok).toBe(true);
    expect(features.getConsentRecordsForFeature('publishing-telegraph', 'default')[0].mechanism).toBe('explicit-written');
    // A self-governing feature passes its activation challenge.
    const sg = await walkToEnabled(byId('autonomous-evolution'), deps);
    expect(sg.ok).toBe(true);
    expect((await read('/features/autonomous-evolution')).data.state.discoveryState).toBe('enabled');
    // A disabled feature comes back in one direct step.
    await request(app).post('/features/evolution-system/transition').set(auth).send({ to: 'disabled' });
    expect((await walkToEnabled(local, deps)).steps).toEqual(['enabled']);

    // The profile, its switch with a reason, and the history it writes.
    const profile = buildProfile(await read('/autonomy'));
    expect(profile.ok).toBe(true);
    const sw = await request(app).post('/autonomy/profile').set(auth).send({ profile: 'collaborative', reason: 'console e2e' });
    expect(sw.status).toBe(200);
    const h = buildHistory(await read('/autonomy/history'));
    expect(h.ok).toBe(true);
    expect(h.rows[0].sub).toBe('console e2e');
    // The guard list maps to rows or an honest reason.
    const g = buildGuards(await read('/guards'));
    if (g.ok) expect(g.counts.total).toBeGreaterThan(0); else expect(g.reason.length).toBeGreaterThan(10);
  });
});
