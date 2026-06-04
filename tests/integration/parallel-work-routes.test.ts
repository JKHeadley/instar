/**
 * Integration tests for GET /parallel-work/activities (Parallel-Work Awareness Phase A).
 * Spec: docs/specs/parallel-activity-coherence.md.
 *
 * Real Express route over a real ParallelActivityIndex: 200 + the cross-topic map when
 * the index is wired, 503 when it is null.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ParallelActivityIndex } from '../../src/core/ParallelActivityIndex.js';
import type { EstablishedRef } from '../../src/core/TopicIntent.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-routes-')); fs.mkdirSync(path.join(tmp, 'topic-intent')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/parallel-work-routes.test.ts' }); });

function ref(kind: EstablishedRef['kind'], text: string): EstablishedRef {
  return {
    refId: 'r', arcId: 'a', topicId: 1, kind, text, confidence: 0.9, evidence: [],
    lastReinforcedAt: '2026-06-04T00:00:00.000Z', status: 'active' as EstablishedRef['status'],
    createdAt: '2026-06-04T00:00:00.000Z', updatedAt: '2026-06-04T00:00:00.000Z',
  };
}

function ctxWith(parallelActivityIndex: ParallelActivityIndex | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: tmp, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    parallelActivityIndex,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(idx: ParallelActivityIndex | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(idx)));
  return app;
}

describe('GET /parallel-work/activities (integration)', () => {
  it('returns 200 + the cross-topic activity map when the index is wired', async () => {
    fs.writeFileSync(path.join(tmp, 'topic-intent', '42.json'), JSON.stringify({ topicId: 42, refs: {} }));
    const idx = new ParallelActivityIndex({
      stateDir: tmp,
      getRefs: () => [ref('goal', 'ship ResourceLedger CPU sampling')],
      isRunning: () => true,
    });
    const res = await request(appWith(idx)).get('/parallel-work/activities');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.runningCount).toBe(1);
    const a = res.body.activities[0];
    expect(a.topicId).toBe(42);
    expect(a.focus).toBe('ship ResourceLedger CPU sampling');
    expect(a.tags).toContain('resourceledger');
    expect(a.running).toBe(true);
  });

  it('returns 503 when the index is null', async () => {
    const res = await request(appWith(null)).get('/parallel-work/activities');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/parallel-activity index unavailable/i);
  });
});
