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
  buildReach, buildNeeds, buildDoing, buildPromised, buildRunning, buildAllowed, headline, combineNeeds,
} from '../../dashboard/console/home-model.js';
import { buildPromisesPage, actionsFor } from '../../dashboard/console/promises-model.js';
import { buildMachinesPage, healthOf } from '../../dashboard/console/machines-model.js';
import { buildAccountsPage } from '../../dashboard/console/accounts-model.js';
import { buildFeatures, buildProfile, buildHistory, buildGuards, walkToEnabled, flattenFeature, canTurnOff, refusalText } from '../../dashboard/console/allowed-model.js';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { buildPlansPage, projectActions, refusalWords } from '../../dashboard/console/plans-model.js';
import { buildCostsPage, windowParams, spendQuery } from '../../dashboard/console/costs-model.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { buildSchedulePage, buildHistory as buildRunHistory, runStartWords } from '../../dashboard/console/schedule-model.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { buildShipping, buildFeedback, buildPace, developmentHeadline, maintainerMode } from '../../dashboard/console/development-model.js';
import { buildAgentsPage, threadModel, pairingModel, relayModel } from '../../dashboard/console/agents-model.js';
import { buildSlips, buildAudit, buildApprovals, mandatesHeadline, mandatesFacts } from '../../dashboard/console/mandates-model.js';
import { buildPreferences, buildCorrections, buildConflicts, learnedHeadline, learnedFacts, correctionsUrl } from '../../dashboard/console/learned-model.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { buildRequests, buildKeys, buildSync, secretsHeadline, secretsFacts, requestBody, resultWords as secretResultWords } from '../../dashboard/console/secrets-model.js';
import { buildListing, buildFile, saveBody, saveResult, buildConfig, configPatch, configResultWords, pinnedFrom, filesHeadline } from '../../dashboard/console/files-model.js';
import { buildActivity, buildChain, buildStats, buildBindings, buildProblems, buildClaims, buildReviews, buildLookup, insideHeadline, recentUrl, failuresUrl, claimsUrl, chainUrl, lookupUrl, revokeRequest } from '../../dashboard/console/inside-model.js';
import { SharedStateLedger } from '../../src/core/SharedStateLedger.js';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import { buildSessions, sessionsHeadline, sessionsFacts, closeRequest, closeResultWords, createBody, createResultWords, doorChoices, machineChoices } from '../../dashboard/console/sessions-model.js';

describe('Console Home E2E (feature is alive)', () => {
  const AUTH = 'console-home-e2e';
  const auth = { Authorization: `Bearer ${AUTH}` };
  let tmp = '';
  let server: AgentServer;
  let tracker: CommitmentTracker;
  let features: FeatureRegistry;
  let initiatives: InitiativeTracker;
  let state: StateManager;
  let scheduler: JobScheduler;
  let jobsFile = '';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-home-e2e-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'server-data'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir), originMachineId: 'e2e' });
    initiatives = new InitiativeTracker(stateDir);
    state = new StateManager(stateDir);
    // Three real jobs for the Schedule page: one with a recorded next-run time in the past
    // (late), one switched off (never late), one whose state says it is running.
    jobsFile = path.join(stateDir, 'jobs.json');
    const jobDef = (slug: string, over: Record<string, unknown>) => ({ slug, name: slug, description: 'e2e', schedule: '0 0 1 1 *', priority: 'low', expectedDurationMinutes: 1, model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'e2e' }, ...over });
    fs.writeFileSync(jobsFile, JSON.stringify([jobDef('e2e-late', {}), jobDef('e2e-off', { enabled: false }), jobDef('e2e-busy', { priority: 'high', expectedDurationMinutes: 5 })], null, 2));
    const nowMs = Date.now();
    state.saveJobState({ slug: 'e2e-late', lastRun: new Date(nowMs - 5 * 3600_000).toISOString(), lastResult: 'success', nextScheduled: new Date(nowMs - 40 * 60_000).toISOString(), consecutiveFailures: 0 });
    state.saveJobState({ slug: 'e2e-off', lastRun: new Date(nowMs - 5 * 3600_000).toISOString(), lastResult: 'failure', lastError: 'old', nextScheduled: new Date(nowMs - 40 * 60_000).toISOString(), consecutiveFailures: 2 });
    state.saveJobState({ slug: 'e2e-busy', lastRun: new Date(nowMs - 2 * 60_000).toISOString(), lastResult: 'pending', consecutiveFailures: 0 });
    const config = { projectName: 'e2e', projectDir: tmp, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10_000, version: '0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile, maxParallelJobs: 1 }, messaging: [], updates: {},
      // The blocker ledger is dev-gated; enabling it here makes GET /blockers a real 200 for the Plans page.
      monitoring: { blockerLedger: { enabled: true } } } as unknown as InstarConfig;
    features = new FeatureRegistry(stateDir, { hmacKey: AUTH });
    await features.open();
    for (const def of BUILTIN_FEATURES) features.register(def);
    const autonomyManager = new AutonomyProfileManager({ stateDir, config });
    const sessionManager = { listRunningSessions: () => [], getSession: () => null } as never;
    // A real JobScheduler over the real jobs file (loaded, not started: no cron tasks, no
    // missed-job sweep — the routes read exactly what the file and the saved state say).
    scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1 } as never, sessionManager, state, stateDir);
    scheduler.refreshJobs();
    server = new AgentServer({ config, commitmentTracker: tracker, initiativeTracker: initiatives, featureRegistry: features, autonomyManager, sessionManager, state, scheduler });
    await server.start();
  });

  afterAll(async () => {
    scheduler.stop();
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
    expect(cards.promised.value).toBe('1 waiting on you');
    // "What needs you" is the one answer: it carries the waiting promise, and
    // the headline counts that card alone, so the two agree (topic 127504).
    const combined = { ...cards, needs: combineNeeds(cards.needs, cards.promised) };
    if (Number.isFinite(cards.needs.count)) {
      expect(combined.needs.count).toBe(cards.needs.count + 1);
    } else {
      // A queue that could not be read stays "can't tell" — never "Nothing needs you".
      expect(combined.needs.value).not.toBe('Nothing needs you');
    }
    expect(headline(combined).text).not.toBe('All quiet.');
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

    // A read-only feature (the runtime ignores its key): the real route refuses the
    // switch with 409 FEATURE_NOT_SWITCHABLE, and the page model offers no switch.
    const ro = byId('evolution-system');
    expect(ro.switchable).toBe(false);
    expect(ro.readOnlyReason).toMatch(/read-only/);
    expect(canTurnOff(ro)).toBe(false);
    const roWalk = await walkToEnabled(ro, deps);
    expect(roWalk).toMatchObject({ ok: false, readOnly: true });
    expect(roWalk.steps).toEqual([]);
    const roSet = await request(app).post('/features/evolution-system/transition').set(auth).send({ to: 'enabled' });
    expect(roSet.status).toBe(409);
    expect(roSet.body.error.code).toBe('FEATURE_NOT_SWITCHABLE');
    // A model walk that skips its own pre-check still stops on the server's 409 as a plain sentence.
    const roForced = await walkToEnabled({ ...ro, switchable: true }, {
      ...deps,
      getInfo: async (id: string) => { const r = await read(`/features/${id}`); return r.ok ? { ok: true, data: { ...r.data, definition: { ...r.data.definition, switchable: true }, validTransitions: ['enabled'] } } : r; },
    });
    expect(roForced).toMatchObject({ ok: false, readOnly: true });
    expect(roForced.message).toMatch(/^This switch is read-only: /);

    // A fresh switchable local-tier feature: undiscovered → enabled, no consent record,
    // and the page shows the server's honest sentence, not just the discovery state.
    const local = byId('external-operation-gate');
    expect(local.switchable).toBe(true);
    expect(local.state).toBe('undiscovered');
    expect(typeof local.stateText).toBe('string');
    const localWalk = await walkToEnabled(local, deps);
    expect(localWalk.steps).toEqual(['aware', 'interested', 'enabled']);
    expect(['applied', 'refused', 'failed', 'not-applied']).toContain(localWalk.apply.outcome);
    // ok is true exactly when the setting followed the switch.
    expect(localWalk.ok).toBe(localWalk.apply.outcome === 'applied');
    const after = flattenFeature((await read('/features/external-operation-gate')).data);
    expect(after.effective).not.toBeNull();
    expect(after.stateText).toBe(after.effective.summary);
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
    const off = await request(app).post('/features/external-operation-gate/transition').set(auth).send({ to: 'disabled', trigger: 'explicit-ask' });
    expect(off.status).toBe(200);
    expect(off.body.apply).toBeTruthy();
    expect(off.body.effective.status).toMatch(/^(off|off-after-restart|not-recorded)$/);
    expect((await walkToEnabled(local, deps)).steps).toEqual(['enabled']);
    // A present-but-invalid dashboard unlock is refused (401), and the page says so plainly.
    const bad = await request(app).post('/features/external-operation-gate/transition').set(auth).set('X-Instar-Operator-Session', 'not-a-real-proof').send({ to: 'disabled' });
    expect(bad.status).toBe(401);
    expect(refusalText({ status: bad.status, data: bad.body })).toMatch(/Unlock with your PIN again/);

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

  it('the Schedule page reads the real /jobs routes through the model: late only when on and local, Run now and the switch meet the real gates', async () => {
    const app = server.getApp();
    const read = async (p: string) => {
      const r = await request(app).get(p).set(auth);
      return r.status === 200 ? { ok: true, data: r.body } : { ok: false, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const readAll = async () => ({ local: await read('/jobs'), pool: await read('/jobs?scope=pool'), history: await read('/jobs/history?limit=500'), migration: await read('/jobs/migration-status'), reconcile: await read('/jobs/reconcile') });
    const page = buildSchedulePage(await readAll(), Date.now());
    expect(page.ok).toBe(true);
    expect(page.counts).toMatchObject({ total: 3, late: 1, failing: 0, running: 1, off: 1 });
    const bySlug = (s: string) => [...page.sections.needs, ...page.sections.coming, ...page.sections.everything].find((r: { slug: string }) => r.slug === s)!;
    // The past next-run time makes the enabled job late, in the plan's words; the same time on the off job does not.
    expect(bySlug('e2e-late')).toMatchObject({ kind: 'late', end: 'late' });
    expect(bySlug('e2e-late').sub).toMatch(/^past its recorded next-run time by \d+ min, not running · last ran 5 h ago ✓$/);
    expect(bySlug('e2e-off')).toMatchObject({ kind: 'off', tone: null });
    expect(bySlug('e2e-busy').kind).toBe('running');
    expect(page.headline).toBe('3 scheduled jobs. 1 is late.');
    expect(JSON.stringify(page)).not.toMatch(/missed|handled/i);
    // Run now meets the real gates: a running job is refused as already running; a switched-off
    // job is not admitted by the live scheduler (it records a skip with its reason).
    const busy = await request(app).post('/jobs/e2e-busy/run').set(auth).send({});
    expect(busy.status).toBe(409);
    expect(runStartWords(busy.status, busy.body).text).toBe('Already running.');
    const off = await request(app).post('/jobs/e2e-off/run').set(auth).send({});
    expect(off.status).toBe(409);
    expect(runStartWords(off.status, off.body).text).toContain('did not admit it');
    const skips = await read('/skip-ledger?slug=e2e-off&sinceHours=1');
    const hist = buildRunHistory(await read('/jobs/e2e-off/history?limit=50'), skips, Date.now());
    expect(hist.ok).toBe(true);
    expect(hist.marks.map((m: { word: string }) => m.word)).toContain('skipped (switched off)');
    // The switch is the bearer-only PATCH; once off, the late job is "off", never late.
    const patched = await request(app).patch('/jobs/e2e-late').set(auth).send({ enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.enabled).toBe(false);
    const after = buildSchedulePage(await readAll(), Date.now());
    expect(after.counts).toMatchObject({ late: 0, off: 2 });
    expect(bySlug('e2e-late').slug).toBe('e2e-late');
    expect(after.sections.needs.map((r: { slug: string }) => r.slug)).toEqual([]);
    const back = await request(app).patch('/jobs/e2e-late').set(auth).send({ enabled: true });
    expect(back.status).toBe(200);
    // Setup issues read the real migration + reconcile routes (an honest empty or items, never a crash).
    expect(Array.isArray(after.setup.items)).toBe(true);
    expect(after.setup.notes).toEqual([]);
    for (const r of [busy, off, patched, back]) expect([401, 403]).not.toContain(r.status);
  });

  it('the Development page runs the real shipping, feedback and pace routes through its model: every 503 maps to honest words, maintainer mode stays a visibility choice, and the PIN routes refuse without one', async () => {
    // The page's own reader keeps the status and the server's error code (a 503 body says WHY).
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      const code = r.body && typeof r.body.error === 'string' ? r.body.error : null;
      return r.status === 200 ? { ok: true, status: 200, data: r.body, code } : { ok: false, status: r.status, data: r.body, code, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const res = {
      watcher: await read('/green-pr-automerge'), verify: await read('/local-verify'), release: await read('/release-readiness'),
      readiness: await read('/feedback-factory/readiness-authorities/proposal'), triageSummary: await read('/feedback-factory/triage/summary'), triageProposal: await read('/feedback-factory/triage/authority/proposal'),
      execute: await read('/feedback-factory/execute/status'), queue: await read('/feedback-factory/triage/queue'), drain: await read('/feedback-factory/drain/status'),
      pace: await read('/throughput/series?days=14'),
    };
    // Every read answered through the real auth + routing stack: a reading or a 503, never a 401/403/404/500.
    for (const [k, r] of Object.entries(res)) expect(r.ok || r.status === 503, k).toBe(true);
    const shipping = buildShipping({ watcher: res.watcher, verify: res.verify, release: res.release }, Date.now());
    const feedback = buildFeedback({ readiness: res.readiness, triageSummary: res.triageSummary, triageProposal: res.triageProposal, execute: res.execute, queue: res.queue, drain: res.drain }, Date.now());
    const pace = buildPace(res.pace, { days: 14, person: 'team' }, Date.now());
    // This bare server has no Instar source checkout and no operated feedback factory: the models say so, in words, never a fabricated zero.
    expect(shipping.state).toBe('off');
    expect(shipping.reason).toContain('aren’t set up on this machine');
    expect(shipping.release.tone).toBe('off');
    expect(feedback.state).toBe('off');
    expect(feedback.headline).toBe('The feedback factory doesn’t run on this machine.');
    expect(feedback.todos).toEqual([]);
    expect(JSON.stringify(feedback)).not.toMatch(/Nothing needs you/);
    // Pace: a GitHub sign-in may or may not exist in this environment; either a real reading or a can't-tell with the fix named.
    if (pace.state === 'ok') expect(pace.headline).toMatch(/^(Last 14 days: |No merges in the last 14 days\.)/);
    else { expect(pace.state).toBe('cant-tell'); expect(pace.reason.length).toBeGreaterThan(10); if (res.pace.code === 'github-auth-unavailable') expect(pace.reason).toContain('no GitHub sign-in found'); }
    expect(developmentHeadline({ shipping, feedback, pace }).text).toBe('Development tools aren’t set up on this machine.');
    // Maintainer mode from the same two repo-gated reads: not detected here; the per-browser switch only forces visibility.
    const mode = maintainerMode({ localVerify: res.verify, greenPr: res.watcher });
    expect(mode).toMatchObject({ visible: false, detected: 'no' });
    expect(maintainerMode({ localVerify: res.verify, greenPr: res.watcher }, 'on').visible).toBe(true);
    // The body-PIN routes refuse (or are dark) without a PIN; the console never sends one it did not just collect, and nothing here answers 200.
    for (const [p, body] of [
      ['/feedback-factory/readiness-authorities', { action: 'create', useProposal: true, operatorDecisionRef: 'e2e' }],
      ['/feedback-factory/triage/authority', { action: 'create', useProposal: true, operatorDecisionRef: 'e2e' }],
      ['/feedback-factory/triage/commit', { planId: 'x', nonce: 'y' }],
      ['/green-pr-automerge/enable', {}],
    ] as const) {
      const r = await request(server.getApp()).post(p).set(auth).set('X-Instar-Request', '1').send(body);
      expect([403, 409, 503], p).toContain(r.status);
    }
    // The bearer-only shipping writes are dark on this server (503), never a silent 200.
    expect((await request(server.getApp()).post('/green-pr-automerge/hold').set(auth).send({ pr: 1, reason: 'e2e' })).status).toBe(503);
    expect((await request(server.getApp()).post('/local-verify').set(auth).send({ pr: 1 })).status).toBe(503);
  });

  it('the Other-agents page runs the real Threadline routes through its model: every 503 maps to honest words, nothing is fabricated as paired or reachable, and the PIN and hub writes refuse without their gates', async () => {
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      const code = r.body && typeof r.body.error === 'string' ? r.body.error : null;
      return r.status === 200 ? { ok: true, status: 200, data: r.body, code } : { ok: false, status: r.status, data: r.body, code, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const res = {
      health: await read('/threadline/health'), pairingRes: await read('/threadline/pairing'), invitesRes: await read('/threadline/pairing/invites'),
      peersRes: await read('/threadline/peers/health?scope=pool'), convRes: await read('/threadline/conversations?scope=mesh'), threadsRes: await read('/threadline/observability/threads'), poolRes: await read('/pool'),
    };
    // Every read answered through the real stack: a reading, a 503, or (the relay health, mounted only with the relay) a 404 — never a 401/403/500.
    for (const [k, r] of Object.entries(res)) expect(r.ok || r.status === 503 || (k === 'health' && r.status === 404), `${k} answered ${r.status}`).toBe(true);
    expect(res.poolRes.ok).toBe(true);
    const page = buildAgentsPage(res, Date.now());
    // Pairing is dev-gated dark on this bare server: the model says "turned off", never "no pairings".
    const pairing = pairingModel(res.pairingRes, res.invitesRes, res.poolRes, Date.now());
    expect(pairing.state).toBe('off');
    expect(pairing.reason).toBe('Pairing is turned off on this agent.');
    // The relay health route is not mounted without the relay: can't tell, never "connected".
    const relay = relayModel(res.health, Date.now());
    expect(['cant-tell', 'not-configured']).toContain(relay.state);
    expect(relay.connected).toBe(false);
    // The real delivery tracker answers with no peers; no agent is invented, and the page is the honest off page.
    expect(res.peersRes.ok).toBe(true);
    expect(page.agents).toEqual([]);
    expect(page.waiting).toEqual([]);
    expect(page.mode).toBe('off');
    expect(page.headline).toMatch(/^The agent network (is|looks) off on this agent\.$/);
    expect(page.sub).toContain('Turn on pairing');
    expect(JSON.stringify(page)).not.toMatch(/reachable\.|Paired/);
    // A conversation's history is dark here too: honest words, no empty history presented as real.
    const t = threadModel(await read('/threadline/threads/thread-e2e-1?limit=200'), await read('/threadline/threads/thread-e2e-1/health'));
    expect(t.ok).toBe(false);
    expect(t.reason).toBe('The message history is switched off on this agent.');
    // The body-PIN pairing routes and the hub binding refuse (or are dark) without their gates; the console never sends a PIN it did not just collect.
    const iid = 'ab'.repeat(16);
    for (const p of [`/threadline/pairing/invites/${iid}/approve`, `/threadline/pairing/invites/${iid}/finish`, `/threadline/pairing/invites/${iid}/not-them`, `/threadline/pairing/invites/${iid}/own-agent`, '/threadline/pairing/invites']) {
      const r = await request(server.getApp()).post(p).set(auth).send({});
      expect([403, 409, 503], p).toContain(r.status);
    }
    const bind = await request(server.getApp()).post('/threadline/hub/bind').set(auth).send({ action: 'open', threadId: 'thread-e2e-1' });
    expect(bind.status).toBe(503);
  });

  it('the Permission-slips page runs the real mandate routes through its model: an empty store reads as "none issued", the record is intact, and every PIN route refuses without one', async () => {
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      return r.status === 200 ? { ok: true, status: 200, data: r.body } : { ok: false, status: r.status, data: r.body, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const [slipsRes, auditRes, approvalsRes, usersRes] = await Promise.all([read('/mandate'), read('/mandate/audit?limit=200'), read('/authorization-requests?status=pending'), read('/permissions/users')]);
    // The real engine is alive on a server with a stateDir: 200, never a 401/403/404/500.
    expect(slipsRes.status).toBe(200);
    expect(auditRes.status).toBe(200);
    expect([200, 503]).toContain(approvalsRes.status); // dev-gated feature: on or honestly off
    expect([200, 500]).toContain(usersRes.status);     // the registry may not exist on a bare server; the page degrades to a text field
    const slips = buildSlips(slipsRes, { now: Date.now() });
    const audit = buildAudit(auditRes, { now: Date.now() });
    const approvals = buildApprovals(approvalsRes);
    expect(slips).toMatchObject({ ok: true, active: [], ended: [], counts: { active: 0, ended: 0, people: 0, invalid: 0 } });
    expect(audit).toMatchObject({ ok: true, rows: [], countLabel: 'No decisions recorded yet.', chain: { state: 'intact' } });
    if (approvalsRes.status === 503) expect(approvals.hidden).toBe(true); else expect(approvals.ok).toBe(true);
    const h = mandatesHeadline({ slips, approvals, audit });
    if (approvals.ok && approvals.rows.length) expect(h.tone).toBe('attn');
    else expect(h).toEqual({ text: 'No slips — every agent-to-agent action is refused until you sign one.', tone: 'ok' });
    expect(mandatesFacts({ slips, approvals, audit })).toContainEqual({ n: 'intact', label: 'decision record', tone: null });
    // Every write the page offers is PIN-gated: without a PIN the server refuses (403) or says no PIN is configured (503); nothing answers 2xx.
    const future = new Date(Date.now() + 3600_000).toISOString();
    for (const [p, body] of [
      ['/mandate/issue', { scope: 'e2e', agents: ['a'.repeat(32), 'b'.repeat(32)], authorities: [{ action: 'sign-code-review', bounds: {} }], expiresAt: future }],
      ['/mandate/nope/revoke', { reason: 'e2e' }],
      ['/mandate/nope/grants', { grants: [{ floorAction: 'prod-deploy', grantedTo: 'U1', authorizedBy: 'e2e', expiresAt: future }] }],
      ['/authorization-requests/nope/approve', {}],
      ['/authorization-requests/nope/deny', { denyReason: 'e2e' }],
    ] as const) {
      const r = await request(server.getApp()).post(p).set(auth).send(body);
      expect([403, 503], p).toContain(r.status);
    }
    // Nothing was issued by those refusals.
    expect((await read('/mandate')).data.mandates).toEqual([]);
  });
  it('the Passwords-&-keys page runs the real Secret Drop routes through its model: an empty list reads as nothing waiting, a create and a cancel go through on the bearer token alone, and no value or length is served to the page', async () => {
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      return r.status === 200 ? { ok: true, status: 200, data: r.body } : { ok: false, status: r.status, data: r.body, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const [pendingRes, ctxRes, syncRes, topicsRes] = await Promise.all([read('/secrets/pending'), read('/self-knowledge/session-context?full=1'), read('/secrets/sync-status'), read('/telegram/topics?scope=pool')]);
    expect(pendingRes.status).toBe(200);
    expect([200, 503]).toContain(ctxRes.status); // dev-gated key list: on, or honestly off
    expect(syncRes.status).toBe(503);            // single-machine: sync is off, the page hides it
    expect(topicsRes.status).toBe(200);
    const requests = buildRequests(pendingRes, { now: Date.now() });
    const keys = buildKeys(ctxRes, syncRes);
    const sync = buildSync(syncRes, null);
    expect(requests).toMatchObject({ ok: true, waiting: [], expired: [], counts: { waiting: 0, soon: 0, expired: 0 } });
    expect(sync).toEqual({ on: false, hidden: true });
    expect(secretsHeadline({ requests, keys, sync })).toEqual({ text: 'Nothing is waiting.', tone: 'ok' });
    expect(secretsFacts({ requests, keys, sync })[0]).toEqual({ n: 0, label: 'waiting', tone: null });
    if (ctxRes.status === 200) expect(keys.ok).toBe(true); else expect(keys).toMatchObject({ ok: false, decryptFailed: false });

    // A create through the page's exact body, on the bearer token alone (no PIN).
    const req = requestBody({ label: 'e2e key', note: 'from the console e2e', topicId: '', ttlMs: '900000' });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const created = await request(server.getApp()).post('/secrets/request').set(auth).send(req.body);
    expect(created.status).toBe(201);
    expect(secretResultWords('create', created.status, created.body).ok).toBe(true);
    const after = buildRequests(await read('/secrets/pending'), { now: Date.now(), origin: 'http://localhost:4040' });
    expect(after.ok && after.waiting.map((c) => c.label)).toEqual(['e2e key']);
    if (!after.ok) return;
    expect(after.waiting[0].link).toEqual({ url: `http://localhost:4040/secrets/drop/${created.body.token}`, remote: false });
    // The drop page itself is real and needs no token (the token is in the URL).
    expect((await request(server.getApp()).get(`/secrets/drop/${created.body.token}`)).status).toBe(200);
    // Cancel, then a second cancel reads as already ended, never as a failure to cancel.
    const del = await request(server.getApp()).delete(`/secrets/pending/${created.body.token}`).set(auth);
    expect(secretResultWords('cancel', del.status, del.body)).toEqual({ ok: true, text: 'Cancelled. The link no longer works.' });
    const again = await request(server.getApp()).delete(`/secrets/pending/${created.body.token}`).set(auth);
    expect(secretResultWords('cancel', again.status, again.body)).toMatchObject({ ok: false, gone: true });
    expect((await read('/secrets/pending')).data.pending).toEqual([]);
    // Without the token, every one of these routes refuses.
    expect((await request(server.getApp()).get('/secrets/pending')).status).toBe(401);
    expect((await request(server.getApp()).post('/secrets/request').send(req.body)).status).toBe(401);
  });

  it('the What-I\'ve-learned page reads honestly when correction learning is off: both sources say switched off, never an empty list', async () => {
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      return r.status === 200 ? { ok: true, status: 200, data: r.body } : { ok: false, status: r.status, data: r.body, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const [p, c] = await Promise.all([read('/preferences/session-context'), read(correctionsUrl())]);
    expect(p.status).toBe(503);
    expect(c.status).toBe(503);
    const prefs = buildPreferences(p);
    const corrections = buildCorrections([c]);
    expect(prefs).toMatchObject({ ok: false, off: true });
    expect(learnedHeadline({ prefs, corrections })).toEqual({ text: 'Learning from corrections is off on this agent.', tone: 'muted' });
  });
  it('the Files page runs the real file routes through its model: browse, a key file refused in words, a save and a 409 conflict on the bearer token alone, and folder settings answered honestly', async () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# e2e\n');
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'note.md'), 'first\n');
    fs.writeFileSync(path.join(tmp, '.instar', 'identity.json'), '{"privateKey":"NEVER-RENDER"}');
    fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'guard.js'), '// hook\n');
    const call = async (method: 'get' | 'post' | 'patch', p: string, body?: unknown) => {
      let r = request(server.getApp())[method](p).set(auth);
      if (body) r = r.set('X-Instar-Request', '1').send(body as object);
      const res = await r;
      return { status: res.status, data: res.body };
    };
    const root = buildListing(await call('get', '/api/files/list?path='), '');
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(root.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['docs', 'CLAUDE.md']));
    expect(filesHeadline({ root, machine: '' }).tone).toBe('ok');
    const instar = buildListing(await call('get', '/api/files/list?path=.instar'), '.instar');
    expect(instar.ok && instar.entries.map((e) => e.name)).not.toContain('identity.json'); // never listed
    expect(pinnedFrom({ '': root }).map((p) => p.path)).toEqual(['CLAUDE.md']);

    // A key file is refused by the server, and the page says so in words.
    const key = buildFile(await call('get', '/api/files/read?path=.instar/identity.json'), '.instar/identity.json');
    expect(key).toMatchObject({ kind: 'refused', refusal: 'never-shown', title: 'Never shown, by design' });
    expect(JSON.stringify(key)).not.toContain('NEVER-RENDER');
    // The agent's settings file is never served at all: refused in words too.
    expect(buildFile(await call('get', '/api/files/read?path=.instar/config.json'), '.instar/config.json')).toMatchObject({ kind: 'refused', refusal: 'never-shown' });

    // Open, save with the opened version (bearer + safety header, no PIN), then a stale save is a conflict.
    const cfg = buildConfig(await call('get', '/api/files/config'));
    expect(cfg.ok).toBe(true);
    const opened = buildFile(await call('get', '/api/files/read?path=docs/note.md'), 'docs/note.md', cfg.ok ? cfg : {});
    expect(opened).toMatchObject({ kind: 'markdown', editable: true, content: 'first\n' });
    const saved = await call('post', '/api/files/save', saveBody('docs/note.md', 'second\n', opened.modified));
    expect(saveResult(saved.status, saved.data)).toMatchObject({ ok: true, text: 'Saved.' });
    expect(fs.readFileSync(path.join(tmp, 'docs', 'note.md'), 'utf-8')).toBe('second\n');
    const stale = await call('post', '/api/files/save', saveBody('docs/note.md', 'third\n', opened.modified));
    expect(saveResult(stale.status, stale.data)).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(path.join(tmp, 'docs', 'note.md'), 'utf-8')).toBe('second\n');
    const forced = await call('post', '/api/files/save', saveBody('docs/note.md', 'third\n', opened.modified, { force: true }));
    expect(saveResult(forced.status, forced.data).ok).toBe(true);
    // A hook reads but is never editable: read-only with its reason, and refused on save too.
    expect(buildFile(await call('get', '/api/files/read?path=.claude/hooks/guard.js'), '.claude/hooks/guard.js')).toMatchObject({ editable: false, readOnlyWhy: 'Hooks and scripts are never editable here.' });
    const hook = await call('post', '/api/files/save', saveBody('.claude/hooks/guard.js', '// changed', undefined as unknown as string));
    expect(saveResult(hook.status, hook.data)).toMatchObject({ ok: false, text: 'This file is never editable here, by design.' });

    // Folder settings: this server has no live config, so a change is refused in words, never faked.
    if (!cfg.ok) return;
    const patch = await call('patch', '/api/files/config', configPatch(cfg, 'allowed', 'add', 'docs/'));
    const words = configResultWords(patch.status, patch.data);
    if (patch.status === 501) expect(words.text).toMatch(/cannot be changed from here/); else expect(words.ok).toBe(true);
    // Without the token, every file route refuses; without the safety header a save is refused.
    expect((await request(server.getApp()).get('/api/files/list?path=')).status).toBe(401);
    expect((await request(server.getApp()).post('/api/files/save').send({ path: 'docs/note.md', content: 'x' })).status).toBe(401);
    expect((await request(server.getApp()).post('/api/files/save').set(auth).send({ path: 'docs/note.md', content: 'x' })).status).toBe(403);
  });
  it('the Sessions page runs the real session routes through its model: an empty list reads as nothing running, a recorded session is listed with its model in words, a close of a gone session reads as already closed, and every write refuses without the token', async () => {
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      return r.status === 200 ? { ok: true, status: 200, data: r.body } : { ok: false, status: r.status, data: r.body, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const empty = await read('/sessions?scope=pool');
    expect(empty.status).toBe(200);
    const m0 = buildSessions(empty, { now: Date.now() });
    expect(m0).toMatchObject({ ok: true, rows: [], counts: { running: 0, quiet: 0 } });
    expect(sessionsHeadline(m0).text).toBe('Nothing is running.');
    expect(sessionsFacts(m0)[0]).toEqual({ n: 0, label: 'running', tone: null });

    // A real running session record: listed, named, its model in words, protected flag present.
    const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    state.saveSession({ id: 'e2e-sess-1', name: 'e2e-sess', tmuxSession: 'e2e-sess', status: 'running', startedAt, model: 'claude-opus-5-5' } as never);
    const one = buildSessions(await read('/sessions?scope=pool'), { now: Date.now() });
    expect(one.ok && one.rows.map((r) => [r.title, r.model, r.session.protected])).toEqual([['e2e-sess', 'Opus 5.5', false]]);
    expect(one.ok && one.rows[0].sub.startsWith('This machine · 30 min')).toBe(true);
    state.saveSession({ id: 'e2e-sess-1', name: 'e2e-sess', tmuxSession: 'e2e-sess', status: 'completed', startedAt, model: 'claude-opus-5-5' } as never);
    expect((buildSessions(await read('/sessions?scope=pool'), { now: Date.now() }) as { rows: unknown[] }).rows).toEqual([]);

    // Close a session that is not running: the page's own request, read as already closed.
    const gone = { tmuxSession: 'no-such-session', id: 'x', remote: false };
    const req = closeRequest(gone);
    const del = await request(server.getApp()).delete(req.path).set(auth);
    expect(del.status).toBe(404);
    expect(closeResultWords(gone, del.status, del.body)).toEqual({ ok: true, gone: true, text: 'Already closed.' });
    // A relay to a machine this agent does not know: refused before any request leaves.
    const remote = { tmuxSession: 'r', id: 'u-1', remote: true, machineId: 'm-unknown', machineNickname: 'Mac Mini' };
    const rreq = closeRequest(remote);
    const rc = await request(server.getApp()).post(rreq.path).set(auth).send(rreq.body!);
    expect(rc.status).toBe(404);
    expect(closeResultWords(remote, rc.status, rc.body).ok).toBe(false);

    // The new-session sheet's sources: doors (or honestly off) and the machine list (single machine: no choice).
    const opts = await read('/topic-profile/options');
    expect([200, 503]).toContain(opts.status);
    if (opts.ok) expect(Array.isArray(doorChoices(opts.data))).toBe(true);
    expect(machineChoices(await read('/pool'))).toBeNull();
    // A create with an empty name never leaves the page; a refused create reads in the server's words.
    expect(createBody({ name: ' ' }, null).ok).toBe(false);
    const bad = await request(server.getApp()).post('/sessions/create').set(auth).set('X-Instar-Request', '1').send({});
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(createResultWords(bad.status, bad.body, '').ok).toBe(false);

    // Without the token, every one of these routes refuses.
    expect((await request(server.getApp()).get('/sessions?scope=pool')).status).toBe(401);
    expect((await request(server.getApp()).delete('/sessions/x')).status).toBe(401);
    expect((await request(server.getApp()).post('/sessions/x/remote-close').send({ machineId: 'm', sessionUuid: 'u' })).status).toBe(401);
    expect((await request(server.getApp()).post('/sessions/create').send({ name: 'x' })).status).toBe(401);
  });

  it('a real internal pipeline wake remains Echo work after its due date, not a Home request', async () => {
    const internal = tracker.record({ userRequest: 'Pipeline wake: restore a usable fallback',
      agentResponse: 'Echo will check the login after reset', type: 'one-time-action',
      source: 'pipeline-wake-2026-10-27T17:50:02Z', owner: 'agent', blockedOn: 'external',
      hardDeadlineAt: new Date(Date.now() - 60_000).toISOString(), verificationMethod: 'manual' } as never);
    const response = await request(server.getApp()).get('/commitments?scope=mesh').set(auth);
    expect(response.status).toBe(200);
    const record = response.body.commitments.find((x: { id: string }) => x.id === internal.id);
    expect(record.source).toMatch(/^pipeline-wake-/);
    const source = { ok: true, data: response.body };
    const home = buildPromised(source);
    const page = buildPromisesPage(source);
    expect(home.rows.some((r) => r.key?.endsWith(`:${internal.id}`))).toBe(false);
    expect(page.sections.missed.some((r) => r.id === internal.id)).toBe(false);
    expect(page.sections.carrying.some((r) => r.id === internal.id)).toBe(true);
  });
});

describe('Console "What I\'ve learned about you" E2E (feature is alive)', () => {
  const AUTH = 'console-learned-e2e';
  const auth = { Authorization: `Bearer ${AUTH}` };
  let tmp = '';
  let server: AgentServer;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-learned-e2e-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'server-data'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    // Real records on disk before the server starts: one learned preference, one watched correction.
    new PreferencesManager(stateDir).recordPreference({ learning: 'Lead with the short answer.', dedupeKey: CorrectionLedger.dedupeKey('user-preference', 'lead with the short answer'), confidence: 0.9 });
    const seed = new CorrectionLedger({ dbPath: path.join(stateDir, 'correction-ledger.db') });
    seed.record({ kind: 'user-preference', learning: 'RAW-LEARNING-NEVER-SERVED', scrubbedSummary: 'Plainer wording', deterministicWeight: 3, topicId: 7 });
    seed.close();
    const config = { projectName: 'e2e', projectDir: tmp, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10_000, version: '0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: path.join(stateDir, 'jobs.json'), maxParallelJobs: 1 }, messaging: [], updates: {},
      monitoring: { correctionLearning: { enabled: true } } } as unknown as InstarConfig;
    const sessionManager = { listRunningSessions: () => [], getSession: () => null } as never;
    server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir) } as never);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/console-home-lifecycle.test.ts' });
  });

  it('runs the real preference and correction routes through the page model: 200, the preference is quoted, the correction is watched, the raw lesson never crosses', async () => {
    const read = async (p: string) => {
      const r = await request(server.getApp()).get(p).set(auth);
      return r.status === 200 ? { ok: true, status: 200, data: r.body } : { ok: false, status: r.status, data: r.body, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
    };
    const [p, c, conflictsRes] = await Promise.all([read('/preferences/session-context'), read(correctionsUrl()), read('/state/conflicts')]);
    expect(p.status).toBe(200);
    expect(c.status).toBe(200);
    expect([200, 503]).toContain(conflictsRes.status); // the replicated-store ledger ships dark: on or honestly off
    expect(JSON.stringify(c.data)).not.toContain('RAW-LEARNING-NEVER-SERVED');
    const prefs = buildPreferences(p);
    const corrections = buildCorrections([c]);
    const conflicts = buildConflicts(conflictsRes);
    expect(prefs).toMatchObject({ ok: true, total: 1, notLoaded: 0 });
    expect(prefs.ok && prefs.rows.map((r) => r.text)).toEqual(['Lead with the short answer.']);
    expect(prefs.ok && prefs.rows[0].sub).toBe('seen once · sure');
    expect(corrections.ok && corrections.watching.map((r) => r.main)).toEqual(['Plainer wording']);
    expect(conflicts.hidden).toBe(true);
    expect(learnedHeadline({ prefs, corrections })).toEqual({ text: 'I’ve picked up 1 thing about how you like to work.', tone: 'ok' });
    expect(learnedFacts({ prefs, corrections, conflicts })).toEqual([{ n: 1, label: 'preference kept' }, { n: 1, label: 'correction being watched' }]);
    // The cursor the "Show older" button sends is accepted by the real route.
    const older = await read(correctionsUrl(new Date().toISOString()));
    expect(older.status).toBe(200);
    expect(buildCorrections([c, older])).toMatchObject({ ok: true, shown: 1, moreFailed: null });
    // The page is read only: the bearer token alone writes nothing through it (POST /corrections needs the intent header).
    expect((await request(server.getApp()).post('/corrections').set(auth).send({})).status).not.toBe(200);
  });
});

describe('Console "How I\'m doing inside" E2E (feature is alive)', () => {
  const AUTH = 'console-inside-e2e';
  const auth = { Authorization: `Bearer ${AUTH}` };
  let tmp = '';
  let server: AgentServer;
  let ledger: SharedStateLedger;
  let commitmentId = '';
  let decisionId = '';
  let replacingId = '';
  const read = async (p: string) => {
    const r = await request(server.getApp()).get(p).set(auth);
    return r.status === 200 ? { ok: true, status: 200, data: r.body } : { ok: false, status: r.status, data: r.body, reason: r.status === 503 ? 'switched off on this agent' : `the server answered ${r.status}` };
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-inside-e2e-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'server-data'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    // Real records before the server starts: two failures in the real ledger, three ledger entries.
    const fl = new FailureLedger({ dbPath: path.join(stateDir, 'failure-ledger.db') });
    fl.open({ filedBy: 'e2e', source: 'agent-diagnosed', severity: 'medium', summary: 'Two writers raced on the state file', detail: { redacted: 'src/x.ts', full: 'FULL-DETAIL-NEVER-SERVED' }, category: 'concurrency', attribution: 'automatic' });
    fl.open({ filedBy: 'e2e', source: 'agent-diagnosed', severity: 'low', summary: 'A setting was misread', detail: { redacted: '', full: '' }, category: 'config-parse', attribution: 'inferred' });
    fl.close();
    ledger = new SharedStateLedger({ stateDir, config: { enabled: true }, salt: 'e2e-salt' });
    const base = { emittedBy: { subsystem: 'threadline' as const, instance: 'e2e' }, provenance: 'subsystem-asserted' as const };
    const decision = await ledger.append({ ...base, kind: 'decision', subject: 'Decided to retry on Codex', counterparty: { type: 'self', name: 'self', trustTier: 'trusted' }, dedupKey: 'e2e:decision' });
    const replacing = await ledger.append({ ...base, kind: 'decision', subject: 'Decided to retry on Opus instead', supersedes: decision!.id, counterparty: { type: 'self', name: 'self', trustTier: 'trusted' }, dedupKey: 'e2e:decision2' });
    const c = await ledger.append({ ...base, emittedBy: { subsystem: 'session', instance: 'sess-1' }, provenance: 'session-asserted', kind: 'commitment', subject: 'Hand off the review to Dawn', counterparty: { type: 'agent', name: 'Dawn', trustTier: 'trusted' }, dedupKey: 'e2e:commit',
      commitment: { mechanism: { type: 'passive-wait', refResolvedAt: new Date().toISOString(), refStatus: 'valid' }, status: 'open', deadline: new Date(Date.now() + 3600_000).toISOString() } });
    decisionId = decision!.id; replacingId = replacing!.id; commitmentId = c!.id;
    const config = { projectName: 'e2e', projectDir: tmp, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10_000, version: '0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: path.join(stateDir, 'jobs.json'), maxParallelJobs: 1 }, messaging: [], updates: {},
      integratedBeing: { enabled: true }, monitoring: { failureLearning: { enabled: true }, correctionClassReview: { enabled: true } } } as unknown as InstarConfig;
    const sessionManager = { listRunningSessions: () => [], getSession: () => null } as never;
    server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), sharedStateLedger: ledger } as never);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/console-home-lifecycle.test.ts' });
  });

  it('runs the real ledger routes through the page model: 200, counted within the window, a commitment is never called open, the chain walks back', async () => {
    const [recent, stats, sessions] = await Promise.all([read(recentUrl()), read('/shared-state/stats'), read('/shared-state/sessions')]);
    expect(recent.status).toBe(200);
    expect(stats.status).toBe(200);
    expect(sessions.status).toBe(503); // the session-write surface (v2) ships off: the bindings block is hidden, not empty
    const a = buildActivity(recent);
    expect(a).toMatchObject({ ok: true, n: 3, line: 'Among the 3 most recent records: 2 decisions.' });
    const c = a.ok && a.rows.find((r) => r.id === commitmentId);
    expect(c && c.status && c.status.key).toBe('unknown');
    expect(c && c.sub).toBe('Commitment · with Dawn · Status unknown: later history isn’t loaded');
    // The decision that was replaced: its later history IS in the window, but it is not a commitment, so no status claim.
    expect(buildStats(stats)).toMatchObject({ ok: true });
    expect(buildBindings(sessions)).toEqual({ ok: false, hidden: true });
    const chain = buildChain(await read(chainUrl(replacingId)));
    expect(chain).toMatchObject({ ok: true, words: 'It replaced 1 earlier record.' });
    expect(chain.ok && chain.rows.map((r) => r.id)).toEqual([replacingId, decisionId]);
    // The counterparty filter is the route's own.
    const agents = buildActivity(await read(recentUrl({ counterparty: 'agent' })), { counterparty: 'agent' });
    expect(agents.ok && agents.rows.map((r) => r.id)).toEqual([commitmentId]);
    // Revoke is refused without the intent header and without the token; with v2 off it answers 503 either way.
    expect((await request(server.getApp()).post(revokeRequest('11111111-1111-4111-8111-111111111111').path)).status).toBe(401);
    expect((await request(server.getApp()).post(revokeRequest('11111111-1111-4111-8111-111111111111').path).set(auth).set('X-Instar-Request', '1')).status).toBe(503);
  });

  it('runs the real failure, claim, review and memory routes: problems are read with the page’s own `before`, the full detail never crosses, off sources read as off', async () => {
    const [insights, first, week, all, claimsRes, reviewsRes] = await Promise.all([
      read('/failures/insights?limit=50'), read(failuresUrl()), read('/failures/analysis?sinceDays=7'), read('/failures/analysis'), read(claimsUrl()), read('/class-reviews?limit=20'),
    ]);
    for (const r of [insights, first, week, all]) expect(r.status).toBe(200);
    expect(JSON.stringify(first.data)).not.toContain('FULL-DETAIL-NEVER-SERVED');
    const older = await read(failuresUrl(new Date(Date.now() + 60_000).toISOString()));
    expect(older.status).toBe(200);
    const p = buildProblems({ insights, pages: [first, older], week, all });
    expect(p).toMatchObject({ ok: true, weekTotal: 2, openShown: 2, line: 'Nothing repeating. 2 one-off problems this week.' });
    expect(p.ok && p.rows.map((r) => r.main).sort()).toEqual(['A settings problem: A setting was misread', 'A timing clash (two things ran at once): Two writers raced on the state file']);
    expect(p.ok && p.stageWords).toBe('Watching quietly (no alerts)');
    expect([200, 503]).toContain(reviewsRes.status);
    expect(buildReviews(reviewsRes).ok || buildReviews(reviewsRes).off).toBe(true);
    expect([200, 503]).toContain(claimsRes.status);
    const claims = buildClaims(claimsRes);
    expect(claims.ok ? claims.contradicted : 'off').not.toBeUndefined();
    // No semantic memory on this agent: the lookup says it is off, never "no sources".
    const mem = await read(lookupUrl({ id: '11111111-1111-4111-8111-111111111111', kind: 'entity' }));
    expect(mem.status).toBe(503);
    expect(buildLookup(mem, { kind: 'entity' })).toMatchObject({ ok: false, off: true });
    const h = insideHeadline({ activity: buildActivity(await read(recentUrl())), problems: p, claims, reviews: buildReviews(reviewsRes) });
    expect(h.tone).toBe('ok');
    // Every route the page reads refuses without the token.
    for (const path of [recentUrl(), '/shared-state/stats', failuresUrl(), '/failures/insights?limit=50', claimsUrl(), '/class-reviews?limit=20']) {
      expect((await request(server.getApp()).get(path)).status, path).toBe(401);
    }
  });

});
