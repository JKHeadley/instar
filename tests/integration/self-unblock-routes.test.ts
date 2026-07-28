/**
 * Integration tests — the /blockers self-unblock extension ("Self-Unblock Before
 * Escalating", spec §7/§8). Tier 2: the REAL inline route in createRoutes(), behind
 * the real authMiddleware, backed by a real SelfUnblockRunStore + BlockerLedger.
 *
 * Covers (spec §8 Integration):
 *   - GET /blockers/self-unblock-runs 200 when the run store is wired
 *   - GET /blockers/self-unblock-runs 503 AFTER auth when dark (401 without bearer)
 *   - Cache-Control: no-store on the read
 *   - a checklist run feeds a persisted, run-id-referenced attempt into BlockerLedger
 *     and the true-blocker settle path is exercised over HTTP
 *   - THE REQUIRED NEGATIVE ANTI-GAMING TEST: with the feature ENABLED (run-store
 *     injected) a settle carrying a caller-embedded failedAttempt but NO persisted
 *     run is HARD-rejected (missing_failed_attempt → 422) — the old caller-supplied
 *     path is CLOSED when enabled.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { BlockerLedger } from '../../src/monitoring/BlockerLedger.js';
import type { SettleAuthority } from '../../src/monitoring/BlockerLedger.js';
import {
  SelfUnblockChecklist,
  SelfUnblockRunStore,
  type ProbeProviders,
} from '../../src/monitoring/SelfUnblockChecklist.js';
import { buildProductionProbeProviders } from '../../src/monitoring/SelfUnblockProbeProviders.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'self-unblock-routes-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
const intent = () => ({ 'X-Instar-Request': '1' });

const allowAuthority: SettleAuthority = async () => ({
  allow: true,
  reason: 'fake allow authority (test)',
  decisionHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
});

function ctxFor(
  stateDir: string,
  ledger: BlockerLedger | null,
  runStore: SelfUnblockRunStore | null,
  checklist: SelfUnblockChecklist | null = null,
): RouteContext {
  return {
    config: {
      projectName: 'self-unblock-routes',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      authToken: AUTH,
      monitoring: { blockerLedger: { enabled: !!ledger } },
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, blockerLedger: ledger, selfUnblockRunStore: runStore,
    selfUnblockChecklist: checklist,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

describe('/blockers/self-unblock-runs route (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-unblock-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/self-unblock-routes.test.ts:afterEach',
    });
  });

  function wiredStore(): SelfUnblockRunStore {
    return new SelfUnblockRunStore({ stateDir });
  }

  function wiredLedger(runStore: SelfUnblockRunStore | null): BlockerLedger {
    return new BlockerLedger({
      stateDir,
      settleAuthority: allowAuthority,
      selfUnblockRunStore: runStore ?? undefined,
      confinedPlaybookRoots: [path.join(stateDir, 'playbooks')],
    });
  }

  /**
   * Build the PRODUCTION checklist exactly as AgentServer would — via
   * buildProductionProbeProviders, with all external access injected (no shell-outs,
   * no network, no declared tags ⇒ fail-closed exhaustion). This exercises the REAL
   * producer path end-to-end, NOT a hand-rolled provider set.
   */
  function productionChecklist(runStore: SelfUnblockRunStore): SelfUnblockChecklist {
    const providers = buildProductionProbeProviders({
      // Reachable-but-no-declared-tags own-vault → exhaustion (the safe default).
      getVaultKeys: () => ['telegram-token'],
      // Everything else: injected exec/fetch returns success but advertises nothing.
      execFileBounded: async () => ({ code: 0, stdout: '{}', stderr: '', timedOut: false }),
      fetchImpl: (async () =>
        ({ ok: true, status: 200, json: async () => ({ result: [] }) }) as unknown as Response) as unknown as typeof fetch,
      getCloudflareToken: () => null,
      // credentialScopeTags OMITTED → nothing surfaced → run exhausts.
    });
    return new SelfUnblockChecklist({ providers, store: runStore });
  }

  it('401 without a bearer token (auth runs BEFORE the 503-when-dark check)', async () => {
    const res = await request(appWith(ctxFor(stateDir, wiredLedger(null), null))).get(
      '/blockers/self-unblock-runs',
    );
    expect(res.status).toBe(401);
  });

  it('503 AFTER auth when the run store is dark', async () => {
    const res = await request(appWith(ctxFor(stateDir, wiredLedger(null), null)))
      .get('/blockers/self-unblock-runs')
      .set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('Self-Unblock checklist not initialized');
  });

  it('200 with an empty list when wired but no runs, and Cache-Control: no-store', async () => {
    const store = wiredStore();
    const res = await request(appWith(ctxFor(stateDir, wiredLedger(store), store)))
      .get('/blockers/self-unblock-runs')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a real checklist run feeds a run-id-referenced attempt into BlockerLedger and the settle path works over HTTP', async () => {
    const store = wiredStore();
    // Produce a GENUINE exhaustion run via the checklist runner (no provider holds
    // a relevant cred → exhausted).
    const providers: ProbeProviders = {
      'own-vault': async () => ({ reachable: true, advertisedScopeTags: ['cloudflare:other.dev'] }),
    };
    // Pin the run's completedAt so the access-request (below) is provably AFTER it.
    const runCompletedAt = new Date('2026-06-14T00:00:00.000Z');
    const checklist = new SelfUnblockChecklist({
      providers,
      store,
      mintRunId: () => 'SUN-int-1',
      now: () => runCompletedAt,
    });
    const run = await checklist.run({
      target: 'cloudflare:feedback.dawn-tunnel.dev',
      requiredAttemptType: 'self-fetch',
    });
    expect(run.exhausted).toBe(true);

    const ledger = wiredLedger(store);
    const app = appWith(ctxFor(stateDir, ledger, store));

    // Open a candidate and settle it as a true-blocker REFERENCING the run id.
    const created = await request(app).post('/blockers').set(auth()).set(intent())
      .send({ detectedText: 'I need the Namecheap DNS credential', origin: 'session-1' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const settled = await request(app).post(`/blockers/${id}/settle`).set(auth()).set(intent())
      .send({
        origin: 'session-1',
        kind: 'true-blocker',
        reasonKind: 'operator-only-secret',
        rebuttal: 'exhausted every reachable source; none holds this credential',
        selfUnblockRunId: 'SUN-int-1',
        accessRequest: { messageRef: 'relay-1', at: '2026-06-14T01:00:00.000Z' },
      });
    expect(settled.status).toBe(200);
    expect(settled.body.state).toBe('true-blocker');
    expect(settled.body.terminal.failedAttempt.detail).toContain('SUN-int-1');

    // The read surface reflects the run + its rung.
    const runsRes = await request(app).get('/blockers/self-unblock-runs').set(auth());
    expect(runsRes.status).toBe(200);
    expect(runsRes.body.runs).toHaveLength(1);
    expect(runsRes.body.runs[0].runId).toBe('SUN-int-1');
    expect(runsRes.body.runs[0].exhausted).toBe(true);
    expect(typeof runsRes.body.runs[0].rung).toBe('number');
  });

  // ── THE REQUIRED NEGATIVE ANTI-GAMING TEST ──
  it('with the feature ENABLED, a settle embedding a caller failedAttempt but NO persisted run is HARD-rejected (422 missing_failed_attempt)', async () => {
    const store = wiredStore(); // store injected → feature ON, but NO run saved
    const ledger = wiredLedger(store);
    const app = appWith(ctxFor(stateDir, ledger, store));

    const created = await request(app).post('/blockers').set(auth()).set(intent())
      .send({ detectedText: 'I need a secret', origin: 'session-1' });
    const id = created.body.id as string;

    const settled = await request(app).post(`/blockers/${id}/settle`).set(auth()).set(intent())
      .send({
        origin: 'session-1',
        kind: 'true-blocker',
        reasonKind: 'operator-only-secret',
        rebuttal: 'only the user has it',
        // the OLD caller-supplied path — hand-crafted attempt, no run id
        failedAttempt: { type: 'self-fetch', detail: 'I totally checked', at: '2026-06-14T00:00:00.000Z' },
        accessRequest: { messageRef: 'relay-1', at: '2026-06-14T01:00:00.000Z' },
      });
    expect(settled.status).toBe(422);
    expect(settled.body.error).toMatch(/self-unblock|VERIFIED|run/i);
  });

  // ── POST /blockers/self-unblock-run — the PRODUCER surface ──
  describe('POST /blockers/self-unblock-run (the producer)', () => {
    it('401 without a bearer token (auth runs BEFORE the 503-when-dark check)', async () => {
      const res = await request(appWith(ctxFor(stateDir, wiredLedger(null), null, null)))
        .post('/blockers/self-unblock-run')
        .set(intent())
        .send({ target: 'cloudflare:feedback.dawn-tunnel.dev' });
      expect(res.status).toBe(401);
    });

    it('503 AFTER auth when the production checklist is dark', async () => {
      const res = await request(appWith(ctxFor(stateDir, wiredLedger(null), null, null)))
        .post('/blockers/self-unblock-run')
        .set(auth())
        .set(intent())
        .send({ target: 'cloudflare:feedback.dawn-tunnel.dev' });
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('producer not initialized');
    });

    it('400 when target is missing/blank', async () => {
      const store = wiredStore();
      const checklist = productionChecklist(store);
      const res = await request(appWith(ctxFor(stateDir, wiredLedger(store), store, checklist)))
        .post('/blockers/self-unblock-run')
        .set(auth())
        .set(intent())
        .send({ requiredAttemptType: 'self-fetch' });
      expect(res.status).toBe(400);
    });

    it('200 when enabled: runs the PRODUCTION checklist, persists the run, Cache-Control no-store', async () => {
      const store = wiredStore();
      const checklist = productionChecklist(store);
      const app = appWith(ctxFor(stateDir, wiredLedger(store), store, checklist));

      const res = await request(app)
        .post('/blockers/self-unblock-run')
        .set(auth())
        .set(intent())
        .send({ target: 'cloudflare:feedback.dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(typeof res.body.runId).toBe('string');
      expect(res.body.exhausted).toBe(true); // no declared tags → fail-closed exhaustion
      expect(typeof res.body.rung).toBe('number');
      expect(Array.isArray(res.body.probes)).toBe(true);
      // The run is now READABLE via the read surface (it was persisted).
      const runsRes = await request(app).get('/blockers/self-unblock-runs').set(auth());
      expect(runsRes.body.runs.some((r: { runId: string }) => r.runId === res.body.runId)).toBe(true);
    });

    it('the produced run then SETTLES a blocker over HTTP — the production path end-to-end', async () => {
      const store = wiredStore();
      const checklist = productionChecklist(store);
      const ledger = wiredLedger(store);
      const app = appWith(ctxFor(stateDir, ledger, store, checklist));

      // 1) PRODUCE a verified run via the production producer surface.
      const runRes = await request(app)
        .post('/blockers/self-unblock-run')
        .set(auth())
        .set(intent())
        .send({ target: 'cloudflare:feedback.dawn-tunnel.dev', requiredAttemptType: 'self-fetch' });
      expect(runRes.status).toBe(200);
      expect(runRes.body.exhausted).toBe(true);
      const runId = runRes.body.runId as string;
      const runAt = runRes.body.completedAt as string;

      // 2) Open a candidate and SETTLE it referencing that run id.
      const created = await request(app).post('/blockers').set(auth()).set(intent())
        .send({ detectedText: 'I need the Namecheap DNS credential', origin: 'session-1' });
      const id = created.body.id as string;

      const afterRun = new Date(new Date(runAt).getTime() + 60_000).toISOString();
      const settled = await request(app).post(`/blockers/${id}/settle`).set(auth()).set(intent())
        .send({
          origin: 'session-1',
          kind: 'true-blocker',
          reasonKind: 'operator-only-secret',
          rebuttal: 'exhausted every reachable source via the production checklist',
          selfUnblockRunId: runId,
          accessRequest: { messageRef: 'relay-1', at: afterRun },
        });
      expect(settled.status).toBe(200);
      expect(settled.body.state).toBe('true-blocker');
      expect(settled.body.terminal.failedAttempt.detail).toContain(runId);
    });
  });
});
