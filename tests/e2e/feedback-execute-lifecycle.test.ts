// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Feedback executor — production construction path, end to end
 * (docs/specs/feedback-triage-and-execution.md §4, Phase 2).
 *
 * ingest (signed receiver → blob inbox → InboxDrainer) → drain readiness → Initiative → triage
 * authority approved with the operator PIN → triage `work` → executor tick: claim → workspaces →
 * confinement canary → confined build session → confined verification → PR (hold label) → the
 * repository owner approves the exact head → safe-merge pinned to it → merged → released + 30 quiet
 * days → Initiative completed. The routes answer 200 when the feature is live and 503 when dark.
 * Only the model and the executor's external boundaries (git, GitHub, sandbox runtime, sessions) are scripted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';
import { handleFeedbackSubmit } from '../../src/feedback-factory/receiver/handlers.js';
import { BlobInboxStore } from '../../src/feedback-factory/receiver/BlobInboxStore.js';
import { BlobInboxClient } from '../../src/feedback-factory/inbox/BlobInboxClient.js';
import { RateLimiter, RATE_LIMITS } from '../../src/feedback-factory/receiver/defense.js';
import { FakeBlobServer } from '../fixtures/FakeBlobServer.js';
import { FEEDBACK_TRIAGE_DECISION_POINT, FEEDBACK_TRIAGE_PROMPT_ID, FEEDBACK_TRIAGE_SCHEMA_ID } from '../../src/feedback-factory/triage/FeedbackTriageArbiter.js';
import { decisionRow, packetsFrom } from '../fixtures/feedbackTriageHarness.js';

const AUTH = 'feedback-execute-e2e-auth';
const PIN = '161803';
const INBOX_SECRET = 'feedback-execute-e2e-inbox-secret';
const TOKEN_ENV = 'FEEDBACK_EXECUTE_E2E_BLOB_TOKEN';
const H = { Authorization: `Bearer ${AUTH}` };
const HX = { ...H, 'X-Instar-Request': '1' };
const baseConfig = (root: string, stateDir: string, extra: Record<string, unknown>) => ({
  projectName: 'e2e', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, requestTimeoutMs: 30_000, version: '0.0.0',
  sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
  scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, ...extra,
}) as unknown as InstarConfig;
const noSessions = { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never;

function prepare(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'feedback-factory', 'store'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'e2e', authToken: AUTH, dashboardPin: PIN }));
  return { root, stateDir };
}


const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

/** Scripted external boundaries for the executor (the only fakes): git, GitHub, sandbox runtime, deps, sessions. */
function executorEdge(root: string, clock: { now: number }) {
  const state = {
    pr: null as null | { number: number; headRefOid: string; mergedAt: string | null; mergeCommit: string | null; labels: string[] },
    reviews: [] as Array<{ login: string; state: string; commitId: string; submittedAt: string }>,
    merges: [] as Array<{ pr: number; sha: string }>, pushes: 0, spawned: [] as string[], alive: new Set<string>(),
    release: 'none' as { tag: string; taggedAt: number } | 'none',
  };
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, '.git'), { recursive: true });
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'src', 'scheduler.ts'), 'export const resume = () => { throw new Error("crash"); };\n');
  const deps = {
    git: {
      fetchBase: async () => BASE_SHA,
      createClone: async (src: string, dest: string) => { fs.cpSync(src, dest, { recursive: true }); },
      commitAndPush: async () => { state.pushes++; return HEAD_SHA; },
      githubRemote: async () => ({ slug: 'owner/repo', url: 'https://github.com/owner/repo.git' }),
      firstReleaseContaining: async () => state.release,
    },
    github: {
      repoInfo: async () => ({ ownerLogin: 'Owner', ownerType: 'User', allowAutoMerge: true }),
      viewerLogin: async () => 'echo-bot',
      createPr: async (input: { label: string }) => { state.pr = { number: 7, headRefOid: HEAD_SHA, mergedAt: null, mergeCommit: null, labels: [input.label] }; return { number: 7 }; },
      prState: async () => (state.pr ? { state: state.pr.mergedAt ? 'MERGED' : 'OPEN', mergedAt: state.pr.mergedAt, headRefOid: state.pr.headRefOid, mergeCommit: state.pr.mergeCommit, author: 'echo-bot', headRefName: 'feedback/x' } : null),
      reviews: async () => state.reviews,
      removeLabel: async () => { state.pr!.labels = []; return true; },
      disableAuto: async () => true,
      safeMerge: async (_slug: string, pr: number, sha: string) => { state.merges.push({ pr, sha }); return { exitCode: 5, stdout: 'safe-merge-result: {"result":"armed"}' }; },
    },
    runner: {
      available: () => ({ ok: true as const, version: '0.0.77' }),
      run: async (cmd: { command: string; cwd: string }) => {
        const c = cmd.command;
        // The (a) base-check clone still has the crashing source; every other tree has the fix.
        const atBase = /-base$/.test(cmd.cwd) && fs.readFileSync(path.join(cmd.cwd, 'src', 'scheduler.ts'), 'utf8').includes('crash');
        const ok = /better-sqlite3/.test(c) || /^git /.test(c) || c === 'npm run lint' || (/vitest/.test(c) && !atBase);
        const out = /vitest/.test(c) && atBase ? 'FAIL tests/scheduler.test.ts\nAssertionError: expected crash not to be thrown' : '';
        return { exitCode: ok ? 0 : 1, signal: null, stdout: out, stderr: '', timedOut: false, outputCapped: false };
      },
    },
    deps: {
      ensure: async () => { const dir = path.join(root, '.worktrees', '.feedback-deps', '0123456789abcdef0123'); fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); return { ok: true as const, dir, hash: '0123456789abcdef0123' }; },
      evict: () => 0, sizeBytes: () => 0,
    },
    sessions: {
      spawnConfined: async (input: { name: string; prompt: string; cwd: string }) => {
        state.spawned.push(input.name);
        if (input.name.startsWith('feedback-canary-')) {
          fs.writeFileSync(/create (\S+\.feedback-canary-ok-[0-9a-f]+)/.exec(input.prompt)![1], 'ok');
          fs.writeFileSync(/echo ok > (\S+\.feedback-canary-bash-[0-9a-f]+)/.exec(input.prompt)![1], 'ok');
          fs.writeFileSync(/write (\S+canary-report-[0-9a-f]+\.json) as JSON/.exec(input.prompt)![1], JSON.stringify({ attempted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], outputs: { 9: 'exit 0' } }));
        } else {
          // The confined build session: reproduce with a failing test, fix, write the result file.
          fs.mkdirSync(path.join(input.cwd, 'tests'), { recursive: true });
          fs.writeFileSync(path.join(input.cwd, 'tests', 'scheduler.test.ts'), "it('resumes without crashing', () => {});\n");
          fs.writeFileSync(path.join(input.cwd, 'src', 'scheduler.ts'), 'export const resume = () => true;\n');
          fs.writeFileSync(path.join(input.cwd, '.feedback-result.json'), JSON.stringify({ outcome: 'fixed', testFiles: ['tests/scheduler.test.ts'], testName: 'resumes without crashing', notes: 'fixed' }));
        }
        return { sessionName: `tmux-${input.name}`, sessionId: `uuid-${input.name}` };
      },
      spawnTrusted: async (input: { name: string }) => { state.spawned.push(input.name); return { sessionName: `tmux-${input.name}`, sessionId: 'u' }; },
      isAlive: (n: string) => state.alive.has(n), stop: async () => true, remoteStop: async () => true, frameworkVersion: async () => '2.1.295',
    },
    identityFacts: () => ({ profileAccounts: [], ownedIdentities: [], vaultNames: null }),
    commitIdentity: () => ({ name: 'Echo', email: 'echo@example.com' }),
    sleep: async () => {}, sessionWaitMs: 1_000, clock: () => clock.now, homeDir: root,
  };
  return { state, deps, source };
}

async function executeTick(app: import('express').Express, clock: { now: number }) {
  clock.now += 60_000;
  const tick = await request(app).post('/feedback-factory/execute/tick').set(HX);
  expect(tick.status, JSON.stringify(tick.body)).toBe(202);
  for (let i = 0; i < 300; i++) {
    const status = await request(app).get('/feedback-factory/execute/status').set(H);
    if (status.body.lastTick?.runId === tick.body.runId) return status.body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('execute tick did not finish');
}

describe('feedback executor — production lifecycle (live on a development agent)', () => {
  let root: string;
  let stateDir: string;
  let server: AgentServer;
  let tracker: InitiativeTracker;
  let blob: FakeBlobServer;
  const clock = { now: Date.now() };
  let edge: ReturnType<typeof executorEdge>;

  beforeAll(async () => {
    ({ root, stateDir } = prepare('feedback-execute-e2e-'));
    edge = executorEdge(root, clock);
    blob = new FakeBlobServer();
    await blob.start();
    process.env[TOKEN_ENV] = 'feedback-execute-e2e-blob-token';
    const inboxClient = new BlobInboxClient({ token: process.env[TOKEN_ENV]!, apiBase: blob.baseUrl });
    for (const [index, body] of Array.from({ length: 3 }, (_, i) => ({ feedbackId: `fb-crash-${i}`, title: 'Scheduler crashes on resume', description: 'untrusted raw detail', type: 'bug' })).entries()) {
      const timestamp = String(Date.now() + index);
      const signature = createHmac('sha256', INBOX_SECRET).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
      const received = await handleFeedbackSubmit({ headers: { 'user-agent': 'instar/1.3.0', 'x-instar-signature': signature, 'x-instar-timestamp': timestamp }, body },
        { store: new BlobInboxStore(inboxClient), rateLimiter: new RateLimiter(RATE_LIMITS), secret: INBOX_SECRET, now: Number(timestamp) });
      expect(received.status).toBe(200);
    }
    tracker = new InitiativeTracker(stateDir);
    const intelligence: IntelligenceProvider = {
      evaluate: async (prompt: string, options?: IntelligenceOptions) => {
        options?.onModel?.({ model: 'claude-fable-5', framework: 'claude-code' });
        if (prompt.includes('registered Feedback Factory triage authority')) {
          return JSON.stringify({ decisions: packetsFrom(prompt).map((p) => decisionRow(p.clusterId, { severity: 'high', priority: 85, userFacing: false })) });
        }
        const ids = [...prompt.matchAll(/"clusterId"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).filter((id) => id !== '...');
        return JSON.stringify({ decisions: [...new Set(ids)].map((clusterId) => ({ clusterId, outcome: 'ready', confidence: 0.97, reasonCodes: ['coherent-recurrence'], evidenceIds: [`cluster:${clusterId}`] })) });
      },
    };
    const config = baseConfig(root, stateDir, {
      developmentAgent: true,
      feedbackFactory: {
        receiverPersistence: { enabled: true, blobTokenEnv: TOKEN_ENV, blobApiBase: blob.baseUrl, pollIntervalMs: 60_000 },
        processing: {}, drain: {}, consumer: { dryRun: false }, triage: {},
        execute: { sourceRepoPath: edge.source, dryRun: false },
      },
    });
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: tracker, intelligence, sessionManager: noSessions,
      feedbackTriageDeps: { quotaUsedPercent: async () => 5, listMergedPrs: async () => [], secondOpinion: () => null, clock: () => clock.now },
      feedbackExecuteDeps: edge.deps as never,
    });
    await server.start();
    const app = server.getApp();
    for (let attempt = 0; attempt < 100; attempt++) {
      const inbox = await request(app).get('/feedback-inbox/status').set(H);
      if (inbox.body?.drained >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  afterAll(async () => {
    await server.stop();
    await blob.stop();
    delete process.env[TOKEN_ENV];
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-execute-lifecycle.test.ts' });
  });

  it('ingest → readiness → Initiative → triage work → executor claim → confined spawn → PR → approved head merged → released + quiet → Initiative completed', async () => {
    const app = server.getApp();
    // The execute routes are alive (200, not 503).
    expect((await request(app).get('/feedback-factory/execute/status').set(H)).status).toBe(200);

    expect((await request(app).post('/feedback-factory/readiness-authorities').set(HX).send({
      pin: PIN, action: 'create', operatorDecisionRef: 'operator-readiness', authorityId: 'feedback-readiness-default', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
      provider: 'claude-code', modelFamily: 'fable-5', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 900, maxDailySpendUsd: 5,
    })).status).toBe(200);
    expect((await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: 10, evidenceHash: 'b'.repeat(64), operatorDecisionId: 'operator-promote' })).status).toBe(200);
    expect((await request(app).post('/feedback-factory/drain/tick').set({ ...HX, 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-execute-e2e-0001' })).status).toBe(202);
    for (let attempt = 0; attempt < 200 && tracker.list().filter((i) => i.feedbackWorkKey).length < 1; attempt++) await new Promise((r) => setTimeout(r, 10));
    const initiative = tracker.list().find((i) => i.feedbackWorkKey)!;
    expect(initiative).toBeDefined();

    expect((await request(app).post('/feedback-factory/triage/authority').set(HX).send({
      pin: PIN, action: 'create', operatorDecisionRef: 'operator-triage', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
      provider: 'claude-code', modelFamily: 'fable-5', maxBatch: 20, maxTokens: 8000, maxDailySpendUsd: 5,
    })).status).toBe(200);
    clock.now += 60_000;
    const triageTick = await request(app).post('/feedback-factory/triage/tick').set(HX);
    expect(triageTick.status).toBe(202);
    for (let i = 0; i < 200; i++) {
      const s = await request(app).get('/feedback-factory/triage/summary').set(H);
      if (s.body.lastTick?.runId === triageTick.body.runId) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await request(app).get('/feedback-factory/triage/queue').set(H)).body.items[0]).toMatchObject({ initiativeId: initiative.id, executionState: 'queued' });

    // Executor: claim → workspaces → canary (both paths) → confined build session.
    let status = await executeTick(app, clock);
    expect(status.counts).toMatchObject({ running: 1 });
    expect(edge.state.spawned[0]).toMatch(/^feedback-canary-/);
    expect(edge.state.spawned[1]).toMatch(/^feedback-.*-a1$/);
    expect((await request(app).get('/feedback-factory/triage/queue').set(H)).body.items[0].executionState).toBe('running');

    // The session ended → confined verification → publication with the hold label.
    status = await executeTick(app, clock);
    expect(status.counts).toMatchObject({ 'pr-open': 1 });
    expect(edge.state.pushes).toBe(1);
    expect(edge.state.pr!.labels).toEqual(['hold']);

    // The repository owner approves the exact head → safe-merge --auto pinned to it → merged.
    edge.state.reviews = [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: new Date(clock.now).toISOString() }];
    status = await executeTick(app, clock);
    expect(edge.state.merges).toEqual([{ pr: 7, sha: HEAD_SHA }]);
    edge.state.pr!.mergedAt = new Date(clock.now).toISOString();
    edge.state.pr!.mergeCommit = 'c'.repeat(40);
    status = await executeTick(app, clock);
    expect(status.counts).toMatchObject({ merged: 1 });
    expect(tracker.get(initiative.id)!.phases.find((p) => p.id === 'build')!.status).toBe('done');
    expect(tracker.get(initiative.id)!.status).not.toBe('completed');

    // Shipped in a release, then 30 quiet days → verify done → Initiative completed.
    edge.state.release = { tag: 'v1.3.9999', taggedAt: clock.now };
    await executeTick(app, clock);
    clock.now += 31 * 24 * 60 * 60_000;
    await executeTick(app, clock);
    expect(tracker.get(initiative.id)!.status).toBe('completed');
    // The audit names transitions without report text.
    const log = fs.readFileSync(path.join(stateDir, 'logs', 'feedback-triage.jsonl'), 'utf8');
    expect(log).toContain('"event":"execute:pr-opened"');
    expect(log).toContain('"event":"execute:verified"');
    expect(log).not.toContain('untrusted raw detail');
  });
});

describe('feedback executor — dark on the fleet', () => {
  let root: string;
  let server: AgentServer;
  beforeAll(async () => {
    let stateDir: string;
    ({ root, stateDir } = prepare('feedback-execute-dark-'));
    const config = baseConfig(root, stateDir, { developmentAgent: false, feedbackFactory: { processing: { enabled: true }, drain: { enabled: true }, consumer: { dryRun: true } } });
    server = new AgentServer({ config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), sessionManager: noSessions });
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-execute-lifecycle.test.ts' });
  });
  it('every execute route answers 503', async () => {
    const app = server.getApp();
    expect((await request(app).get('/feedback-factory/execute/status').set(H)).status).toBe(503);
    expect((await request(app).post('/feedback-factory/execute/tick').set(HX)).status).toBe(503);
    expect((await request(app).post('/feedback-factory/execute/stop').set(HX).send({ initiativeId: 'x' })).status).toBe(503);
  });
});
