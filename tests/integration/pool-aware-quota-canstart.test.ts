/**
 * Integration (Tier 2): the POOL-AWARE quota throttle through the real
 * GET /autonomous/can-start HTTP pipeline.
 *
 * Proves the full route → canStartAutonomousJob → QuotaTracker.shouldSpawnSession
 * path with a wired pool-placeability provider (as server.ts wires it): a single
 * walled account no longer stops the agent — can-start is ALLOWED when the pool has
 * a placeable account, and STOPS when none is placeable.
 *
 * Each scenario builds its OWN server + QuotaTracker.
 *
 * Spec: docs/specs/POOL-AWARE-QUOTA-THROTTLE-SPEC.md
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import { QuotaTracker, type PoolQuota } from '../../src/monitoring/QuotaTracker.js';
import type { InstarConfig, QuotaState, JobSchedulerConfig } from '../../src/core/types.js';
import express from 'express';
import { createRoutes } from '../../src/server/routes.js';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const thresholds: JobSchedulerConfig['quotaThresholds'] = {
  normal: 50, elevated: 70, critical: 85, shutdown: 95,
};

const teardowns: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (teardowns.length) await teardowns.pop()!(); });

/** Stand up a fresh server whose QuotaTracker has a wired pool provider. */
async function buildServer(provider: () => PoolQuota | null): Promise<string> {
  const project: TempProject = createTempProject();
  // Underlying file says the active account is fully walled — the provider must override it.
  const quotaFile = path.join(project.stateDir, 'quota-state.json');
  const walled: QuotaState = { usagePercent: 100, source: 'anthropic-oauth', lastUpdated: new Date().toISOString() };
  fs.writeFileSync(quotaFile, JSON.stringify(walled));

  const config: InstarConfig = {
    projectDir: project.dir, stateDir: project.stateDir,
    projectName: 'test-project', agentName: 'test-agent',
    autonomousSessions: { maxConcurrent: 5 },
  } as InstarConfig;
  const sm = new StateManager(project.stateDir);
  const quotaTracker = new QuotaTracker({ quotaFile, thresholds, maxStalenessMs: 60 * 60 * 1000 });
  quotaTracker.setPoolQuotaProvider(provider);

  const app = express();
  app.use(express.json());
  const router = createRoutes({
    config, state: sm,
    sessionManager: { sendInput: () => true } as any,
    scheduler: null, telegram: null, relationships: null,
    feedback: null, dispatches: null, updateChecker: null, autoUpdater: null,
    autoDispatcher: null, quotaTracker, publisher: null, viewer: null, tunnel: null,
    evolution: null, watchdog: null, triageNurse: null, topicMemory: null,
    feedbackAnomalyDetector: null, projectMapper: null, coherenceGate: null,
    contextHierarchy: null, canonicalState: null, operationGate: null, sentinel: null,
    adaptiveTrust: null, memoryMonitor: null, orphanReaper: null, coherenceMonitor: null,
    commitmentTracker: null, semanticMemory: null, activitySentinel: null, workingMemory: null,
    quotaManager: null, systemReviewer: null, capabilityMapper: null, topicResumeMap: null,
    autonomyManager: null as any, trustElevationTracker: null as any, autonomousEvolution: null,
    discoveryEvaluator: null, completionEvaluator: null as any, startTime: new Date(),
  } as any);
  app.use(router);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  teardowns.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    project.cleanup();
  });
  return baseUrl;
}

describe('Pool-aware quota throttle via /autonomous/can-start (integration)', () => {
  it('ALLOWS can-start when the pool has a placeable account (underlying file is 100%)', async () => {
    const baseUrl = await buildServer(() => ({ placeable: true, weeklyPercent: 0, fiveHourPercent: 0 }));
    const res = await fetch(`${baseUrl}/autonomous/can-start?priority=medium`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(true);
    expect(body.reason).toBe('ok'); // canStartAutonomousJob forwards the tracker reason only on denial
  });

  it('STOPS can-start when no account is placeable', async () => {
    const baseUrl = await buildServer(() => ({ placeable: false }));
    const res = await fetch(`${baseUrl}/autonomous/can-start?priority=medium`);
    const body = await res.json();
    expect(body.allowed).toBe(false);
    expect(body.reason).toMatch(/no placeable account/i);
  });

  it('applies priority load-shedding on the best placeable account', async () => {
    // best placeable account in the elevated band (>=70,<85): high+ only.
    const baseUrl = await buildServer(() => ({ placeable: true, weeklyPercent: 72, fiveHourPercent: 0 }));
    const low = await (await fetch(`${baseUrl}/autonomous/can-start?priority=low`)).json();
    const high = await (await fetch(`${baseUrl}/autonomous/can-start?priority=high`)).json();
    expect(low.allowed).toBe(false);
    expect(high.allowed).toBe(true);
  });
});
