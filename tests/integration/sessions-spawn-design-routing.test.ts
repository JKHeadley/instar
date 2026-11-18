// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — POST /sessions/spawn design routing
 * (docs/specs/frontier-design-review-standard.md §2, build stage 1).
 *
 * Full HTTP route pipeline with a REAL TopicProfileStore, a REAL
 * TopicProfileOrchestrator, a REAL review ledger file and a stub classifier
 * and pool; the session manager is the shared mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileOrchestrator } from '../../src/core/TopicProfileOrchestrator.js';
import { TopicSpawnBriefStore } from '../../src/core/TopicSpawnBriefStore.js';
import type { ResolvedTopicProfile } from '../../src/core/TopicProfileResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { designReviewLedgerPath, type DesignReviewRun } from '../../src/core/designReviewLedger.js';
import { createMockSessionManager, type MockSessionManager } from '../helpers/setup.js';
import { makeOrchestratorDeps, newRecorder, type OrchestratorRecorder } from '../helpers/topicProfileOrchestratorDeps.js';

const LANE = 'claude-fable-5-2';
const PINNED_TOPIC = 5151;
const SUPPRESSED_TOPIC = 5152;
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

function confirmingRun(account: string | null): DesignReviewRun {
  return {
    v: 1, runId: `r-${account ?? 'default'}`, machineId: 'local', recordedAt: new Date().toISOString(),
    path: '/p/plan.md', fingerprint: 'a'.repeat(64), title: 'Plan', sessionId: 's', account,
    passes: [{ family: 'claude', door: 'claude-code', attempts: [{ askedModel: LANE, outcome: 'ok' }], model: LANE, modelBasis: 'reported', status: 'ok', verdict: 'CLEAN' }],
  };
}

describe('POST /sessions/spawn — design routing', () => {
  let tmpDir: string;
  let sm: MockSessionManager;
  let store: TopicProfileStore;
  let orch: TopicProfileOrchestrator;
  let rec: OrchestratorRecorder;
  let orchStatePath: string;
  let classifierReply: string;
  let evaluate: ReturnType<typeof vi.fn>;
  let accounts: unknown[] | null;

  const resolveProfile = (topicKey: string | number): ResolvedTopicProfile => {
    const pin = store.resolve(String(topicKey));
    return {
      framework: pin?.framework ?? 'claude-code',
      model: pin?.model ?? undefined,
      modelTier: pin?.modelTier ?? null,
      thinkingMode: undefined,
      effort: undefined,
      escalationOverride: Number(topicKey) === SUPPRESSED_TOPIC ? 'suppress' : 'inherit',
      sources: { framework: 'pin', model: pin?.model ? 'pin' : 'default', thinkingMode: 'default', effort: 'default' },
      notices: [],
    } as ResolvedTopicProfile;
  };

  function appWith(config: Record<string, unknown>): express.Express {
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: tmpDir, port: 0, ...config },
      sessionManager: sm,
      startTime: new Date(),
      intelligence: { evaluate },
      subscriptionPool: { list: () => accounts ?? [] },
      topicProfile: { store, resolver: { resolve: resolveProfile }, orchestrator: orch, spawnBriefs: new TopicSpawnBriefStore(tmpDir) },
    };
    if (accounts === null) ctx.subscriptionPool = null;
    app.use(createRoutes(ctx));
    return app;
  }

  const spawn = (app: express.Express, body: Record<string, unknown>) =>
    request(app).post('/sessions/spawn').set('Authorization', 'Bearer test').send({ name: `s-${Math.random().toString(36).slice(2, 8)}`, prompt: 'Write the design for the export feature.', ...body });

  const seedLedger = (...runs: DesignReviewRun[]) =>
    fs.writeFileSync(designReviewLedgerPath(tmpDir), runs.map((r) => JSON.stringify(r)).join('\n') + '\n');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-design-routing-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    store = new TopicProfileStore({ stateFilePath: path.join(tmpDir, 'state', 'topic-profiles.json') });
    await store.mutate(String(PINNED_TOPIC), { model: 'claude-opus-5-5', updatedBy: 'api-token' });
    rec = newRecorder();
    orchStatePath = path.join(tmpDir, 'state', 'topic-profile-orchestrator.json');
    orch = new TopicProfileOrchestrator(makeOrchestratorDeps({ store, resolveProfile, stateFilePath: orchStatePath, rec }));
    sm = createMockSessionManager();
    classifierReply = '{"kind":"design"}';
    evaluate = vi.fn(async () => classifierReply);
    accounts = null;
  });

  afterEach(() => {
    orch.dispose();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/sessions-spawn-design-routing.test.ts' });
  });

  const args = () => sm._lastSpawnArgs as any;

  it('a declared design spawn with a confirmed default login launches on the design model and records it', async () => {
    seedLedger(confirmingRun(null));
    const res = await spawn(appWith({ developmentAgent: true }), { workKind: 'design' });
    expect(res.status).toBe(201);
    expect(args().model).toBe(LANE);
    expect(args().accountPin).toBeUndefined();
    expect(args().designRouting).toEqual({ workKind: 'design', workKindSource: 'declared', designRouting: { decision: 'design-lane', model: LANE } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('an undeclared design brief is classified and routed; the account with evidence and room is pinned', async () => {
    accounts = [
      { id: 'acct-a', framework: 'claude-code', configHome: '/h/a', status: 'active', lastQuota: { fiveHour: { utilizationPct: 30, resetsAt: FUTURE } } },
      { id: 'acct-b', framework: 'claude-code', configHome: '/h/b', status: 'active', lastQuota: null },
    ];
    seedLedger(confirmingRun('acct-a'));
    const res = await spawn(appWith({ developmentAgent: true }), {});
    expect(res.status).toBe(201);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(args().model).toBe(LANE);
    expect(args().accountPin).toEqual({ accountId: 'acct-a', configHome: '/h/a' });
    expect(args().designRouting.workKindSource).toBe('classified');
  });

  it('a pinned launch names its framework, and a refused pin falls back to today\'s launch', async () => {
    accounts = [{ id: 'acct-a', framework: 'claude-code', configHome: '/h/a', status: 'active', lastQuota: null }];
    seedLedger(confirmingRun('acct-a'));
    const app = appWith({ developmentAgent: true });
    await spawn(app, { workKind: 'design' });
    expect(args().framework).toBe('claude-code');
    expect(args().accountPin).toEqual({ accountId: 'acct-a', configHome: '/h/a' });
    const real = sm.spawnSession.bind(sm);
    let calls = 0;
    (sm as any).spawnSession = async (opts: any) => {
      calls++;
      if (opts.accountPin) throw new Error('account-pin-framework-unsupported');
      return real(opts);
    };
    const res = await spawn(app, { workKind: 'design', topicId: PINNED_TOPIC });
    expect(res.status).toBe(201);
    expect(calls).toBe(2);
    expect(args().accountPin).toBeUndefined();
    // Today's launch: the topic's own pin, and the topic record says so.
    expect(args().model).toBe('claude-opus-5-5');
    expect(args().designRouting.designRouting.decision).toBe('lane-refused');
    const durable = JSON.parse(fs.readFileSync(orchStatePath, 'utf8'));
    expect(JSON.stringify(durable)).toContain('claude-opus-5-5');
    expect(JSON.stringify(durable.lastApplied?.[String(PINNED_TOPIC)] ?? durable)).not.toContain(LANE);
  });

  it('a build brief, and a mixed design-and-build brief, run on today\'s model', async () => {
    seedLedger(confirmingRun(null));
    classifierReply = '{"kind":"other"}';
    const res = await spawn(appWith({ developmentAgent: true }), { prompt: 'Design and then build the export feature.' });
    expect(res.status).toBe(201);
    expect(args().model).toBeUndefined();
    expect(args().designRouting).toEqual({ workKind: 'other', workKindSource: 'classified', designRouting: { decision: 'not-design', model: null } });
    await spawn(appWith({ developmentAgent: true }), { workKind: 'build' });
    expect(args().designRouting.designRouting.decision).toBe('not-design');
  });

  it('an explicit model wins and is recorded', async () => {
    seedLedger(confirmingRun(null));
    await spawn(appWith({ developmentAgent: true }), { workKind: 'design', model: 'claude-opus-5-5' });
    expect(args().model).toBe('claude-opus-5-5');
    expect(args().designRouting.designRouting).toEqual({ decision: 'explicit-model', model: 'claude-opus-5-5' });
  });

  it('a remote target is not routed, and the refusal says so', async () => {
    seedLedger(confirmingRun(null));
    const before = sm._lastSpawnArgs;
    const res = await spawn(appWith({ developmentAgent: true }), { workKind: 'design', targetMachineId: 'm_peer', topicId: PINNED_TOPIC });
    expect(res.status).toBe(409);
    expect(res.body.designRouting).toEqual({ decision: 'remote-not-routed', model: null });
    expect(sm._lastSpawnArgs).toBe(before);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a suppressed topic is not routed', async () => {
    seedLedger(confirmingRun(null));
    await spawn(appWith({ developmentAgent: true }), { workKind: 'design', topicId: SUPPRESSED_TOPIC });
    expect(args().model).toBeUndefined();
    expect(args().designRouting.designRouting.decision).toBe('suppressed');
  });

  it('no confirming review yet: lane refused, today\'s model, reason recorded', async () => {
    const res = await spawn(appWith({ developmentAgent: true }), { workKind: 'design' });
    expect(res.status).toBe(201);
    expect(args().model).toBeUndefined();
    expect(args().designRouting.designRouting).toEqual({ decision: 'lane-refused', reason: 'not-confirmed', model: null });
  });

  it('a pool whose only confirmed account has no room: lane refused with no-room', async () => {
    accounts = [{ id: 'acct-a', framework: 'claude-code', configHome: '/h/a', status: 'active', lastQuota: { fable: { utilizationPct: 100, resetsAt: FUTURE } } }];
    seedLedger(confirmingRun('acct-a'));
    await spawn(appWith({ developmentAgent: true }), { workKind: 'design' });
    expect(args().model).toBeUndefined();
    expect(args().designRouting.designRouting.reason).toBe('no-room');
  });

  it('design routing outranks a topic pin, and the profile orchestrator does not respawn the session', async () => {
    seedLedger(confirmingRun(null));
    const res = await spawn(appWith({ developmentAgent: true }), { workKind: 'design', topicId: PINNED_TOPIC });
    expect(res.status).toBe(201);
    expect(args().model).toBe(LANE);
    rec.sessions.set(String(PINNED_TOPIC), res.body.tmuxSession);
    const afterRestart = new TopicProfileOrchestrator(makeOrchestratorDeps({ store, resolveProfile, stateFilePath: orchStatePath, rec }));
    afterRestart.bootReconcileSweep();
    await new Promise((r) => setTimeout(r, 80));
    afterRestart.dispose();
    expect(rec.kills).toEqual([]);
    expect(rec.spawns).toEqual([]);
  });

  it('a pinned topic\'s build spawn keeps the pin', async () => {
    seedLedger(confirmingRun(null));
    await spawn(appWith({ developmentAgent: true }), { workKind: 'build', topicId: PINNED_TOPIC });
    expect(args().model).toBe('claude-opus-5-5');
  });

  it('the fleet (not a development agent): nothing is recorded and no classifier call is made', async () => {
    seedLedger(confirmingRun(null));
    const res = await spawn(appWith({}), {});
    expect(res.status).toBe(201);
    expect(args().model).toBeUndefined();
    expect(args().designRouting).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a classifier outage cannot fail the spawn', async () => {
    seedLedger(confirmingRun(null));
    evaluate.mockRejectedValueOnce(new Error('provider down'));
    const res = await spawn(appWith({ developmentAgent: true }), {});
    expect(res.status).toBe(201);
    expect(args().designRouting).toMatchObject({ workKind: 'unknown', workKindSource: 'unknown' });
  });

  it('rejects an unknown workKind and a non-true reviewHandoff', async () => {
    const app = appWith({ developmentAgent: true });
    expect((await spawn(app, { workKind: 'plan' })).status).toBe(400);
    expect((await spawn(app, { reviewHandoff: false })).status).toBe(400);
    expect((await spawn(app, { workKind: 'design', reviewHandoff: true })).status).toBe(201);
  });
});
