/**
 * Tier-2 integration coverage for GET /autonomous/liveness through a REAL booted
 * AgentServer (so the global auth middleware is live):
 *   - 401 without a Bearer token,
 *   - 503 when the reconciler is dark (not wired),
 *   - 200 when the reconciler is wired, reflecting the LIVE status() (not a stub),
 *   - wiring integrity: the route delegates to the real component instance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  AutonomousLivenessReconciler,
  type AutonomousLivenessReconcilerDeps,
} from '../../src/monitoring/AutonomousLivenessReconciler.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-liveness-routes';

function baseConfig(tmpDir: string, stateDir: string): InstarConfig {
  return {
    projectName: 'liveness-routes', projectDir: tmpDir, stateDir, port: 0,
    authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], updates: {}, monitoring: {},
  } as unknown as InstarConfig;
}

/** A live reconciler over inert deps (never actuates; just exposes status()). */
function liveReconciler(): AutonomousLivenessReconciler {
  const deps: AutonomousLivenessReconcilerDeps = {
    now: () => 1_000_000,
    listActiveRuns: () => [],
    liveTopicSnapshot: () => new Set<number>(),
    queuePaused: () => false,
    topicInResumeQueue: () => false,
    operatorStoppedSince: () => false,
    topicOwnerElsewhere: () => false,
    holdsLease: () => true,
    currentGenerationMs: () => null,
    quotaOk: () => true,
    sessionCountOk: () => true,
    migrationInFlight: () => false,
    pressureTier: () => 'normal',
    inflightSpawnStatus: () => ({ state: 'none' }),
    resolveResumeUuid: () => null,
    resolveCwd: () => null,
    bindingUnambiguous: () => true,
    respawn: async () => {},
    claimInflight: () => true,
    releaseClaim: () => {},
    settleKill: async () => {},
    notifyTopic: async () => {},
    raiseAggregated: () => {},
    audit: () => {},
  };
  return new AutonomousLivenessReconciler(deps, { enabled: true, dryRun: true });
}

function mkTmp(): { tmpDir: string; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-routes-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  return { tmpDir, stateDir };
}

describe('GET /autonomous/liveness (integration)', () => {
  it('surfaces completed-turn recovery through the real HTTP status route', async () => {
    const t = mkTmp();
    const recovered: number[] = [];
    const idle = new Map<number, string>([[700, 'echo-topic-700']]);
    const deps: AutonomousLivenessReconcilerDeps = {
      now: () => 1_000_000,
      listActiveRuns: () => [{ topicId: 700, remainingSeconds: 3600, paused: false, movedTo: null, moveSuspended: false, startedAtMs: 900_000 }],
      liveTopicSnapshot: () => new Set([700]),
      idleTopicSnapshot: () => idle,
      queuePaused: () => false, topicInResumeQueue: () => false, operatorStoppedSince: () => false,
      topicOwnerElsewhere: () => false, holdsLease: () => true, currentGenerationMs: () => null,
      quotaOk: () => true, sessionCountOk: () => true, migrationInFlight: () => false,
      pressureTier: () => 'normal', inflightSpawnStatus: () => ({ state: 'none' }),
      resolveResumeUuid: () => 'uuid', resolveCwd: () => t.tmpDir, bindingUnambiguous: () => true,
      respawn: async () => {},
      recoverIdle: async ({ topicId }) => { recovered.push(topicId); idle.delete(topicId); return true; },
      claimInflight: () => true, releaseClaim: () => {}, settleKill: async () => {}, notifyTopic: async () => {},
      raiseAggregated: () => {}, audit: () => {},
    };
    const reconciler = new AutonomousLivenessReconciler(deps, { enabled: true, dryRun: false, debounceTicks: 1, debounceWindowSec: 0 });
    const server = new AgentServer({
      config: baseConfig(t.tmpDir, t.stateDir),
      sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
      state: new StateManager(t.stateDir), autonomousLivenessReconciler: reconciler,
    });
    try {
      await server.start();
      await reconciler.tick();
      const res = await request(server.getApp()).get('/autonomous/liveness').set({ Authorization: `Bearer ${AUTH}` });
      expect(res.status).toBe(200);
      expect(recovered).toEqual([700]);
      expect(res.body.conditions).toContainEqual(expect.objectContaining({ topicId: 700, state: 'turn-revived' }));
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(t.tmpDir, { recursive: true, force: true, operation: 'tests/integration/autonomous-liveness-routes.test.ts' });
    }
  });

  describe('DARK — reconciler not wired', () => {
    let tmpDir: string; let server: AgentServer;
    let app: ReturnType<AgentServer['getApp']>;

    beforeAll(async () => {
      const t = mkTmp(); tmpDir = t.tmpDir;
      server = new AgentServer({
        config: baseConfig(tmpDir, t.stateDir),
        sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
        state: new StateManager(t.stateDir),
        // autonomousLivenessReconciler deliberately OMITTED → dark → 503
      });
      await server.start();
      app = server.getApp();
    });
    afterAll(async () => {
      await server.stop();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/autonomous-liveness-routes.test.ts' });
    });

    it('401 without a Bearer token', async () => {
      const res = await request(app).get('/autonomous/liveness');
      expect(res.status).toBe(401);
    });

    it('503 when authed but the reconciler is dark', async () => {
      const res = await request(app).get('/autonomous/liveness').set({ Authorization: `Bearer ${AUTH}` });
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('autonomous-liveness-reconciler');
    });
  });

  describe('LIVE — reconciler wired', () => {
    let tmpDir: string; let server: AgentServer;
    let app: ReturnType<AgentServer['getApp']>;
    const reconciler = liveReconciler();

    beforeAll(async () => {
      const t = mkTmp(); tmpDir = t.tmpDir;
      server = new AgentServer({
        config: baseConfig(tmpDir, t.stateDir),
        sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
        state: new StateManager(t.stateDir),
        autonomousLivenessReconciler: reconciler,
      });
      await server.start();
      app = server.getApp();
    });
    afterAll(async () => {
      await server.stop();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/autonomous-liveness-routes.test.ts' });
    });

    it('200 when wired, returns the status payload', async () => {
      const res = await request(app).get('/autonomous/liveness').set({ Authorization: `Bearer ${AUTH}` });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ enabled: true, dryRun: true });
      expect(res.body).toHaveProperty('conditions');
      expect(res.body).toHaveProperty('respawnTotal');
    });

    it('wiring integrity: the route reflects the LIVE instance (a real tick mutates lastTickAt)', async () => {
      const before = (await request(app).get('/autonomous/liveness').set({ Authorization: `Bearer ${AUTH}` })).body.lastTickAt;
      await reconciler.tick(); // drive the real instance
      const after = (await request(app).get('/autonomous/liveness').set({ Authorization: `Bearer ${AUTH}` })).body.lastTickAt;
      expect(before).toBeNull();
      expect(after).not.toBeNull(); // the route serves the SAME instance we ticked
    });
  });
});
