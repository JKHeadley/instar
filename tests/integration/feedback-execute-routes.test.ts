// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The feedback executor over the real HTTP pipeline (docs/specs/feedback-triage-and-execution.md §4,
 * Frontloaded Decision 7). A real AgentServer with the executor's external boundaries (git, GitHub,
 * the sandbox runtime, the dependency cache, sessions) scripted at the edge. Covers: the status
 * route (200 live, 503 without a source checkout or when disabled), the tick's refusals (503
 * approver-not-independent, auto-merge-disabled) and the disabled stop path, the two executor PIN
 * plan/commit actions (Bearer renders, only the PIN commits), the conversational stop/release levers,
 * and the non-owner posture (409 naming the owner).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { FeedbackExecutorServiceOptions } from '../../src/feedback-factory/execute/FeedbackExecutorService.js';

const AUTH = 'feedback-execute-routes-auth';
const PIN = '271828';
const H = { Authorization: `Bearer ${AUTH}` };
const HX = { ...H, 'X-Instar-Request': '1' };

interface Fakes { repo: { ownerLogin: string; ownerType: string; allowAutoMerge: boolean }; viewer: string; disarmed: number[] }

function deps(fakes: Fakes): Partial<FeedbackExecutorServiceOptions> {
  return {
    git: {
      fetchBase: async () => 'a'.repeat(40), createClone: async () => {}, commitAndPush: async () => 'b'.repeat(40),
      githubRemote: async () => ({ slug: 'owner/repo', url: 'https://github.com/owner/repo.git' }), firstReleaseContaining: async () => 'none',
    },
    github: {
      repoInfo: async () => fakes.repo, viewerLogin: async () => fakes.viewer, createPr: async () => null, prState: async () => null, reviews: async () => [],
      removeLabel: async () => true, disableAuto: async (_s, pr) => { fakes.disarmed.push(pr); return true; }, safeMerge: async () => ({ exitCode: 1, stdout: '' }),
    },
    runner: { available: () => ({ ok: true, version: '0.0.77' }), run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }) },
    deps: { ensure: async () => ({ ok: false, reason: 'not in this test' }), evict: () => 0, sizeBytes: () => 0 },
    sessions: {
      spawnConfined: async () => { throw new Error('no sessions in this test'); }, spawnTrusted: async () => { throw new Error('no sessions in this test'); },
      isAlive: () => false, stop: async () => true, remoteStop: async () => true, frameworkVersion: async () => 'test',
    },
    identityFacts: () => ({ profileAccounts: [], ownedIdentities: [], vaultNames: null }),
    commitIdentity: () => ({ name: 'Echo', email: 'echo@example.com' }),
  };
}

async function makeServer(opts: { root: string; execute?: Record<string, unknown>; sourceRepo?: boolean; meshSelfId?: string; operatedHostMachineId?: string; fakes: Fakes }) {
  const stateDir = path.join(opts.root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'feedback-factory', 'store'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'studio', authToken: AUTH, dashboardPin: PIN }));
  const sourceRepo = path.join(opts.root, 'source');
  if (opts.sourceRepo !== false) fs.mkdirSync(path.join(sourceRepo, '.git'), { recursive: true });
  const config = {
    projectName: 'studio', projectDir: opts.root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    feedbackFactory: {
      ...(opts.operatedHostMachineId ? { operatedHostMachineId: opts.operatedHostMachineId } : {}),
      processing: {}, drain: {}, consumer: { dryRun: true }, triage: {},
      execute: { ...(opts.sourceRepo !== false ? { sourceRepoPath: sourceRepo } : {}), ...(opts.execute ?? {}) },
    },
  } as unknown as InstarConfig;
  const server = new AgentServer({
    config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), intelligence: { evaluate: async () => '{}' },
    sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    ...(opts.meshSelfId ? { meshSelfId: opts.meshSelfId } : {}),
    feedbackTriageDeps: { secondOpinion: () => null, quotaUsedPercent: async () => 10, listMergedPrs: async () => [] },
    feedbackExecuteDeps: deps(opts.fakes) as never,
  });
  await server.start();
  return server;
}

describe('feedback execute routes — owner', () => {
  let root: string;
  let server: AgentServer;
  const fakes: Fakes = { repo: { ownerLogin: 'Owner', ownerType: 'User', allowAutoMerge: true }, viewer: 'owner', disarmed: [] };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-execute-routes-'));
    server = await makeServer({ root, fakes });
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-execute-routes.test.ts' });
  });

  it('status is alive (200) with the executor\'s dry-run default', async () => {
    const res = await request(server.getApp()).get('/feedback-factory/execute/status').set(H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, dryRun: true, limits: { maxConcurrent: 2, maxStartsPerDay: 6, maxOpenPrs: 4 } });
  });

  it('the tick needs X-Instar-Request and refuses (503) while the agent itself could act as the approver', async () => {
    const app = server.getApp();
    expect((await request(app).post('/feedback-factory/execute/tick').set(H)).status).toBe(403);
    const refused = await request(app).post('/feedback-factory/execute/tick').set(HX);
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ reason: 'approver-not-independent', approver: 'Owner' });
    const summary = await request(app).get('/feedback-factory/execute/status').set(H);
    expect(summary.body.reason).toBe('approver-not-independent');
  });

  it('accepting approver dependence: the Bearer renders the plan, only the dashboard PIN commits it', async () => {
    const app = server.getApp();
    const plan = await request(app).post('/feedback-factory/triage/plan').set(HX).send({ action: 'accept-approver-dependence' });
    expect(plan.status).toBe(200);
    expect(plan.body.renderedText).toMatch(/Accepted risk, by name/);
    expect((await request(app).post('/feedback-factory/triage/commit').set(HX).send({ planId: plan.body.planId, nonce: plan.body.nonce })).status).toBe(403);
    const committed = await request(app).post('/feedback-factory/triage/commit').set(HX).send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({ committed: true, action: 'accept-approver-dependence', approver: 'Owner' });
    // A used plan cannot be replayed.
    expect((await request(app).post('/feedback-factory/triage/commit').set(HX).send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce })).status).toBe(409);
    const tick = await request(app).post('/feedback-factory/execute/tick').set(HX);
    expect(tick.status).toBe(202);
    expect(tick.body.runId).toMatch(/^execute-run:/);
  });

  it('publishing a secret-shaped change set needs a held attempt; the levers validate input', async () => {
    const app = server.getApp();
    expect((await request(app).post('/feedback-factory/triage/plan').set(HX).send({ action: 'publish-secret-shape', attemptId: 'nope:a1' })).status).toBe(409);
    expect((await request(app).post('/feedback-factory/triage/plan').set(HX).send({ action: 'unknown' })).status).toBe(400);
    expect((await request(app).post('/feedback-factory/execute/stop').set(HX).send({})).status).toBe(400);
    expect((await request(app).post('/feedback-factory/execute/stop').set(HX).send({ initiativeId: 'feedback-none' })).body).toEqual({ stopped: 0 });
    expect((await request(app).post('/feedback-factory/execute/release').set(HX).send({ initiativeId: 'feedback-none' })).body).toEqual({ released: false });
  });

  it('the acceptance can be withdrawn with the Bearer token (it only reduces authority); the tick refuses again', async () => {
    const app = server.getApp();
    expect((await request(app).post('/feedback-factory/execute/revoke-acceptance').set(H)).status).toBe(403);
    expect((await request(app).post('/feedback-factory/execute/revoke-acceptance').set(HX)).body).toEqual({ revoked: true });
    const tick = await request(app).post('/feedback-factory/execute/tick').set(HX);
    expect(tick.status).toBe(503);
    expect(tick.body.reason).toBe('approver-not-independent');
  });

  it('auto-merge disabled on the repository → 503', async () => {
    fakes.repo.allowAutoMerge = false;
    const res = await request(server.getApp()).post('/feedback-factory/execute/tick').set(HX);
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('auto-merge-disabled');
    fakes.repo.allowAutoMerge = true;
  });
});

describe('feedback execute routes — dark, disabled, no source checkout, non-owner', () => {
  const roots: string[] = [];
  const servers: AgentServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.stop();
    for (const r of roots) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'feedback-execute-routes.test.ts' });
  });
  async function serverWith(o: Omit<Parameters<typeof makeServer>[0], 'root' | 'fakes'>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-execute-routes-'));
    roots.push(root);
    const s = await makeServer({ root, fakes: { repo: { ownerLogin: 'Owner', ownerType: 'User', allowAutoMerge: true }, viewer: 'bot', disarmed: [] }, ...o });
    servers.push(s);
    return s.getApp();
  }

  it('no source checkout → 503 no-source-repo on status and tick', async () => {
    const app = await serverWith({ sourceRepo: false });
    const status = await request(app).get('/feedback-factory/execute/status').set(H);
    expect(status.status).toBe(503);
    const tick = await request(app).post('/feedback-factory/execute/tick').set(HX);
    expect(tick.status).toBe(503);
    expect(tick.body.reason).toBe('no-source-repo');
  });

  it('disabled → 503 disabled (the tick still runs the disarm stop path)', async () => {
    const app = await serverWith({ execute: { enabled: false } });
    expect((await request(app).get('/feedback-factory/execute/status').set(H)).body.reason).toBe('disabled');
    const tick = await request(app).post('/feedback-factory/execute/tick').set(HX);
    expect(tick.status).toBe(503);
    expect(tick.body.reason).toBe('disabled');
  });

  it('a non-owner answers 409 naming the owner', async () => {
    const app = await serverWith({ meshSelfId: 'standby-machine', operatedHostMachineId: 'owner-machine' });
    const tick = await request(app).post('/feedback-factory/execute/tick').set(HX);
    expect(tick.status).toBe(409);
    expect(tick.body).toMatchObject({ error: 'not-canonical-owner', owner: 'owner-machine' });
  });
});
