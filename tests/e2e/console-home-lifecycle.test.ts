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
import { buildPlansPage, projectActions, refusalWords } from '../../dashboard/console/plans-model.js';
import { buildCostsPage, windowParams, spendQuery } from '../../dashboard/console/costs-model.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';

describe('Console Home E2E (feature is alive)', () => {
  const AUTH = 'console-home-e2e';
  const auth = { Authorization: `Bearer ${AUTH}` };
  let tmp = '';
  let server: AgentServer;
  let tracker: CommitmentTracker;
  let features: FeatureRegistry;
  let initiatives: InitiativeTracker;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-home-e2e-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'server-data'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir), originMachineId: 'e2e' });
    initiatives = new InitiativeTracker(stateDir);
    const config = { projectName: 'e2e', projectDir: tmp, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10_000, version: '0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
      // The blocker ledger is dev-gated; enabling it here makes GET /blockers a real 200 for the Plans page.
      monitoring: { blockerLedger: { enabled: true } } } as unknown as InstarConfig;
    features = new FeatureRegistry(stateDir, { hmacKey: AUTH });
    await features.open();
    for (const def of BUILTIN_FEATURES) features.register(def);
    const autonomyManager = new AutonomyProfileManager({ stateDir, config });
    server = new AgentServer({ config, commitmentTracker: tracker, featureRegistry: features, autonomyManager, initiativeTracker: initiatives,
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

  it('the Plans page reads the real /projects, /initiatives and /blockers routes and its writes meet the real gates', async () => {
    await initiatives.create({ id: 'e2e-plan', title: 'Pick the launch name', description: 'd', phases: [{ id: 'a', name: 'Draft' }], needsUser: true, needsUserReason: 'choose between two names' } as never);
    await initiatives.create({ id: 'e2e-project', title: 'Console makeover', description: 'd', kind: 'project', phases: [{ id: 'a', name: 'Rounds' }],
      rounds: [{ name: 'Home', itemIds: ['e2e-piece'], status: 'pending' }, { name: 'Work', itemIds: [], status: 'pending' }] } as never);
    await initiatives.create({ id: 'e2e-piece', title: 'Home screen', description: 'd', phases: [{ id: 'a', name: 'Build' }], parentProjectId: 'e2e-project', pipelineStage: 'building' } as never);
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      return r.status === 200 ? { ok: true, data: r.body } : { ok: false, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const projects = await read('/projects');
    expect(projects.ok).toBe(true);
    const page = buildPlansPage({
      initiatives: await read('/initiatives'), digest: await read('/initiatives/digest'), projects,
      details: { 'e2e-project': await read('/projects/e2e-project?reconcile=false') },
      blockers: await read('/blockers'), floor: await read('/autonomous/throughput-floor'),
    }, Date.now());
    expect(page.ok).toBe(true);
    // The real needs-you initiative leads; the project waits for its first OK; the child folds under it.
    const needs = page.sections.needsYou.map((r: { id: string; needs: string }) => [r.id, r.needs]);
    expect(needs).toEqual(expect.arrayContaining([['e2e-plan', 'Waiting on you: choose between two names'], ['e2e-project', 'Waiting for your OK on round 1']]));
    expect(page.sections.needsYou.find((r: { id: string }) => r.id === 'e2e-project')!.sub).toContain('round 1 of 2 · 0 of 1 piece merged');
    expect([...page.sections.inFlight, ...page.sections.needsYou].some((r: { id: string }) => r.id === 'e2e-piece')).toBe(false);
    // Blockers answered through the real ledger: an honest empty, never a fabricated "stuck".
    expect(page.inTheWay.state).toBe('ok');
    expect(page.counts.stuck + page.counts.working).toBe(0);
    // Autonomous runs are not observed on this bare server, and the page says exactly that.
    expect(page.runs.state).toBe('off');
    expect(page.runs.reason).toBe('Autonomous runs aren’t observed on this agent.');
    // Writes meet the real gates: Resume on a round that is not halted is refused with the server's reason;
    // the OK and Stop routes need the round runner, which this server does not carry.
    const acts = projectActions(page.sections.needsYou.find((r: { id: string }) => r.id === 'e2e-project')!.record);
    expect(acts.ack).toBe(0);
    const resume = await request(server.getApp()).post('/projects/e2e-project/resume').set(auth).send({ roundIndex: 1 });
    expect(resume.status).toBe(409);
    expect(refusalWords(resume.body.error).text).toContain('nothing to resume');
    const ack = await request(server.getApp()).post('/projects/e2e-project/ack').set(auth).send({ forRoundIndex: acts.ack });
    expect([200, 503]).toContain(ack.status);
    if (ack.status === 503) expect(refusalWords(ack.body.error).text).toContain('off on this agent');
    const halt = await request(server.getApp()).post('/projects/e2e-project/halt').set(auth).send({ reason: 'e2e' });
    expect([200, 409, 503]).toContain(halt.status);
    // No PIN on any of these routes: the bearer token alone reached the gate (never a 401/403).
    for (const r of [resume, ack, halt]) expect([401, 403]).not.toContain(r.status);
  });

  it('the costs page runs the real spend, token, metrics, insights and routing routes through its model and maps every answer to honest words', async () => {
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      return r.status === 200 ? { ok: true, data: r.body } : { ok: false, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const w = windowParams('week');
    const res = {
      spend: await read(`/routing-spend/summary?${spendQuery('day', w.sinceHours)}`), caps: await read('/routing-spend/caps'), status: await read('/routing-spend/enable-status'),
      metrics: await read(`/metrics/features?sinceHours=${w.sinceHours}`), insights: await read('/insights/llm-activity'),
      tokens: await read(`/tokens/summary?since=${w.sinceMs}`), claude: await read(`/tokens/sessions?since=${w.sinceMs}&limit=20`), codex: await read(`/tokens/codex-sessions?since=${w.sinceMs}&limit=20`), orphans: await read('/tokens/orphans?idleMs=1800000'),
      chains: await read('/intelligence/routing/chains'), names: {},
    };
    // Every read answered through the real auth + routing stack (never a 401/403/404/500).
    for (const [k, r] of Object.entries(res)) if (k !== 'names') expect((r as { ok: boolean; reason?: string }).ok || /switched off/.test((r as { reason: string }).reason), k).toBe(true);
    const page = buildCostsPage(res, Date.now(), { window: 'week' });
    expect(typeof page.headline).toBe('string');
    expect(page.headline.length).toBeGreaterThan(10);
    // A 503 maps to "switched off" words, a 200 to a real reading — never a fabricated figure.
    const off = (s: string) => s === 'off';
    if (off(page.recorded.state)) expect(page.headline).toBe('Spend figures aren’t available on this agent.');
    else { expect(page.recorded.state).toBe('ok'); expect(page.headline).toMatch(/^(No pay-per-use cost|About \$[\d.]+ of pay-per-use cost) this week on this machine\.$/); }
    if (off(page.checks.state)) expect(page.checks.reason).toBe('Background checks aren’t tracked on this agent.');
    else { expect(page.checks.state).toBe('ok'); expect(typeof page.checks.real).toBe('number'); }
    if (off(page.conversations.state)) expect(page.conversations.reason).toBe('Conversation token use isn’t tracked here.');
    else {
      expect(page.conversations.state).toBe('ok');
      // The two lines come from the real summary fields and are never one total.
      expect(page.conversations.claude.line).toMatch(/^Claude: \d+ conversations? processed /);
      if (page.conversations.codex) expect(page.conversations.codex.line).toMatch(/^Codex: .* over (its|their) whole life\.$/);
    }
    if (off(page.routing.state)) expect(page.routing.reason).toBe('No AI routing is configured on this agent.');
    else expect(page.routing.state).toBe('ok');
    expect(['off', 'ok', 'failed']).toContain(page.limits.controls.state);
    expect(page.limits.controls.state).not.toBe('failed');
    for (const f of page.facts) { expect(typeof f.label).toBe('string'); expect(String(f.n).length).toBeGreaterThan(0); }
    // The console sends no write to any money route; the only write-shaped routes refuse or are dark.
    const freeze = await request(server.getApp()).post('/routing-spend/freeze').set(auth).send({ keyRef: 'x' });
    expect([400, 404, 409, 503]).toContain(freeze.status);
  });
});
