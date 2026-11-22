// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "the feature is alive" — the Gemini pay-per-use GO-LIVE
 * (docs/specs/gemini-payg-metered-lane.md §8, §11 E2E).
 *
 * Two parts:
 *  1. The real AgentServer, booted the way server.ts boots it with the fleet default
 *     (money off): the go-live is constructed (wiring integrity) and its routes answer
 *     honestly — never 404.
 *  2. The whole operator path on the production init order (the harness mirrors
 *     AgentServer: surface always, money layer only from the operator's flag, the lane
 *     and the go-live on every machine, the intent applied before serving), across a
 *     simulated restart: money on, intent applied, the release gate satisfied with
 *     fakes, then POST /intelligence/gemini returns 200 — not 503 — a row settles, a
 *     mid-month cap refuses, and the next Pacific month reopens.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { nextPeriodBoundaryMs } from '../../src/core/MeteredSpendLedger.js';
import { GEMINI_PAYG_FIRST_SCREEN_LINE } from '../../src/core/geminiPaygGoLive.js';
import { bootMachine, seedManifest, startFakeGoogle, writeHandoffArtifacts, PIN, KEY } from '../integration/geminiPaygGoLiveHarness.js';

describe('Gemini pay-per-use go-live — wired on the real AgentServer (money off)', () => {
  let tmpDir: string;
  let server: AgentServer;
  const AUTH = 'test-e2e-gemini-payg-golive';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-payg-golive-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir) });
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/gemini-payg-go-live-alive.test.ts' });
  });
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('the go-live is constructed and delegates to real pieces (wiring integrity)', () => {
    const g = server.geminiPaygGoLive;
    expect(g).not.toBeNull();
    expect(typeof g!.port.prepareRender).toBe('function');
    expect(g!.recorder.evaluate().releaseState).toBe('not-armed');
    expect(g!.capsDetail()).toBeNull();
  });

  it('its routes are alive with money off: proposal read 200, handoff validates 400, release-proof refuses honestly', async () => {
    const p = await request(server.getApp()).get('/routing-spend/gemini-payg/proposal').set(auth());
    expect(p.status).toBe(200);
    expect(p.body.present).toBe(false);
    const h = await request(server.getApp()).post('/routing-spend/key-handoff').set(auth()).send({ nope: true });
    expect(h.status).toBe(400);
    const r = await request(server.getApp()).post('/routing-spend/release-proof').set(auth()).send({});
    expect(r.status).not.toBe(404);
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('money-layer-off');
    const unauth = await request(server.getApp()).post('/routing-spend/caps/lower').send({ dailyCapUsd: 1 });
    expect(unauth.status).toBe(401);
  });
});

describe('Gemini pay-per-use go-live — the whole operator path, across a restart', () => {
  let projectDir: string;
  let stateDir: string;
  let google: Awaited<ReturnType<typeof startFakeGoogle>>;
  let clock = Date.parse('2026-11-20T18:00:00Z');
  const now = () => clock;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-golive-proj-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-golive-state-'));
    seedManifest(projectDir, true);
    google = await startFakeGoogle();
  });
  afterAll(async () => {
    await google.close();
    for (const d of [projectDir, stateDir]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/gemini-payg-go-live-alive.test.ts' });
  });

  it('money on, intent applied, release gate satisfied, then 200 — a row settles — a mid-month cap refuses — the next Pacific month reopens', async () => {
    const machine = { self: 'm_studio', name: 'Studio', stateDir, projectDir, origin: google.origin, vault: { gemini_api_key_payg: KEY }, now };

    // ── Boot 1: money OFF. The account lane hands off; the agent proposes; Justin approves once.
    const a = bootMachine(machine);
    expect((await request(a.app).post('/routing-spend/key-handoff/mint-start').send({})).status).toBe(200);
    clock += 60_000;
    const handoff = writeHandoffArtifacts(path.join(stateDir, 'lane'), { readAt: new Date(clock).toISOString() });
    clock += 1_000;
    expect((await request(a.app).post('/routing-spend/key-handoff').send(handoff)).status).toBe(200);
    const proposal = await request(a.app).post('/routing-spend/gemini-payg/proposal').send({});
    expect(proposal.status).toBe(200);
    const plan = await request(a.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    expect(plan.status).toBe(200);
    expect(plan.body.renderedText.split('\n')[0]).toBe(GEMINI_PAYG_FIRST_SCREEN_LINE);
    const commit = await request(a.app).post('/routing-spend/money-layer/commit').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce, proposalHash: proposal.body.proposalHash });
    expect(commit.status).toBe(200);
    expect(commit.body.restartRequired).toBe(true);
    expect(commit.body.restart.scheduled).toBe(true);
    expect(a.restarts).toHaveLength(1);
    // No caps write while money is off — only the flag and the intent.
    expect(fs.existsSync(path.join(stateDir, 'state', 'routing-spend-caps.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'state', 'money-pending-setup.json'))).toBe(true);

    // ── Boot 2: the money layer constructs from the operator's flag and applies the intent before serving.
    const b = bootMachine(machine);
    await b.surface.onBoot();
    expect(b.surface.servingReady()).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'money-pending-setup.json'))).toBe(false);
    expect(b.capsStore!.read().doorPolicy?.['gemini-api']?.releaseState).toBe('armed-pending-proof');
    const pending = await request(b.app).post('/intelligence/gemini').send({ prompt: 'is this right?', purpose: 'e2e' });
    expect(pending.status).toBe(423);
    expect(pending.body.reason).toBe('armed-pending-proof');

    // ── The release gate, satisfied with fakes: verified prices (seeded), the proof call, one browser-read.
    expect((await request(b.app).post('/routing-spend/reconciliation').send({ month: '2026-11', figureUsd: 0 })).status).toBe(200);
    const proof = await request(b.app).post('/routing-spend/release-proof').send({});
    expect(proof.status).toBe(200);
    expect(proof.body.evaluation.releaseState, JSON.stringify(proof.body)).toBe('live');
    const paidAfterProof = google.generateCalls();

    // ── Alive: 200, not 503, and a row settles.
    const callId = 'ab'.repeat(16);
    const ok = await request(b.app).post('/intelligence/gemini').send({ prompt: 'is this right?', purpose: 'e2e', callId });
    expect(ok.status).toBe(200);
    expect(ok.body.text).toBe('ready');
    expect(google.generateCalls()).toBe(paidAfterProof + 1);
    const month = b.ledger!.committed('gemini_api_key_payg');
    expect(month.committedMonthUsd).toBeGreaterThan(0);
    expect(month.outstandingReserveUsd).toBe(0);
    const caps = await request(b.app).get('/routing-spend/caps');
    expect(caps.body.geminiPayg.releaseState).toBe('live');
    expect(caps.body.geminiPayg.month.capUsd).toBe(50);

    expect(b.ledger!.lookupCall(callId)?.state).toBe('settled');

    // ── A mid-month cap refuses. The agent lowers the month so that one more second
    // opinion no longer fits this month's share (40% of the month) but would fit an empty one.
    const reserve = b.ledger!.lookupCall(callId)!.reserveUsd;
    const e2Used = caps.body.geminiPayg.e2.monthUsd as number;
    expect(e2Used).toBeGreaterThan(0);
    const lowerTo = Math.round(((reserve + e2Used / 2) / 0.4) * 1e6) / 1e6;
    const lowered = await request(b.app).post('/routing-spend/caps/lower').send({ monthlyCapUsd: lowerTo });
    expect(lowered.status).toBe(200);
    const refused = await request(b.app).post('/intelligence/gemini').send({ prompt: 'one more?', purpose: 'e2e' });
    expect(refused.status).toBe(402);
    // A lower month also shrinks the second-opinion share (40% of it), which binds first.
    expect(['cap-exceeded', 'e2-share-exceeded']).toContain(refused.body.reason);
    expect(refused.body.period).toBe('month');

    // ── The next Pacific month reopens.
    clock = nextPeriodBoundaryMs(clock, 'America/Los_Angeles', 'month') + 60 * 60_000;
    const reopened = await request(b.app).post('/intelligence/gemini').send({ prompt: 'new month?', purpose: 'e2e' });
    expect(reopened.status).toBe(200);
  }, 60_000);
});
