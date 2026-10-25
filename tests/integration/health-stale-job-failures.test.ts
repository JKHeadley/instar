/**
 * GET /health reports a job failure only while it can still change.
 *
 * The real HTTP pipeline, with a scheduler holding one disabled job carrying a
 * month-old failure count and one enabled job that failed minutes ago — the exact
 * production shape from 2026-10-21, where /health answered
 * `consecutiveJobFailures: 119` on an agent with nothing wrong.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true, force: true,
      operation: 'tests/integration/health-stale-job-failures.test.ts:cleanup',
    });
  }
});

interface JobFixture { slug: string; enabled: boolean; failures: number; lastRun: string | null }

async function health(jobs: JobFixture[], authed = true): Promise<Record<string, unknown>> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-jobfail-'));
  dirs.push(projectDir);
  const token = crypto.randomBytes(16).toString('hex');
  const bySlug = new Map(jobs.map((j) => [j.slug, j]));
  const ctx = {
    config: {
      projectName: 'test', projectDir, stateDir: path.join(projectDir, '.instar'),
      port: 0, authToken: token,
    },
    sessionManager: {
      listRunningSessions: () => [],
      getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
    },
    state: {
      getJobState: (slug: string) => {
        const j = bySlug.get(slug);
        return j ? { consecutiveFailures: j.failures, lastRun: j.lastRun } : null;
      },
      getSession: () => null,
    },
    scheduler: { getJobs: () => jobs.map((j) => ({ slug: j.slug, enabled: j.enabled })) },
    telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, correctionLedger: null, coordinator: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const router = createRoutes(ctx);
  const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    let status = 200;
    const headers = new Map<string, unknown>();
    const res = {
      status(code: number) { status = code; return this; },
      json(body: Record<string, unknown>) { resolve({ status, body }); return this; },
      send(body: Record<string, unknown>) { resolve({ status, body }); return this; },
      end() { resolve({ status, body: {} }); return this; },
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
      removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    };
    router.handle(
      {
        method: 'GET', url: '/health', originalUrl: '/health',
        headers: authed ? { authorization: `Bearer ${token}` } : {},
      } as never,
      res as never,
      (err?: unknown) => err ? reject(err) : reject(new Error('health route fell through')),
    );
  });
  expect(response.status).toBe(200);
  return response.body;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe('GET /health — job-failure currency', () => {
  it('counts only the enabled, recent failure and names the excluded one', async () => {
    const body = await health([
      {
        slug: 'w29-working-set-mirror', enabled: false, failures: 118,
        lastRun: '2026-09-26T07:01:15.227Z',
      },
      { slug: 'commitment-detection', enabled: true, failures: 1, lastRun: minutesAgo(30) },
    ]);
    expect(body.consecutiveJobFailures).toBe(1);
    expect(body.staleJobFailures).toEqual({
      total: 118,
      windowHours: 24,
      jobs: [{
        slug: 'w29-working-set-mirror', failures: 118,
        lastRun: '2026-09-26T07:01:15.227Z', reason: 'disabled',
      }],
    });
    // The whole point: 119 old failures no longer drag the verdict down.
    // ('ok' is this route's healthy value — asserted literally, because a test that
    // accepts "anything but degraded" would pass on a typo'd third state.)
    expect(body.status).toBe('ok');
  });

  it('omits staleJobFailures entirely when nothing was excluded', async () => {
    const body = await health([
      { slug: 'fine', enabled: true, failures: 2, lastRun: minutesAgo(5) },
    ]);
    expect(body.consecutiveJobFailures).toBe(2);
    expect(body).not.toHaveProperty('staleJobFailures');
  });

  it('still degrades on five or more CURRENT failures — the bound narrows, it does not disarm', async () => {
    const body = await health([
      { slug: 'broken', enabled: true, failures: 6, lastRun: minutesAgo(1) },
    ]);
    expect(body.consecutiveJobFailures).toBe(6);
    expect(body.status).toBe('degraded');
  });

  it('keeps the excluded detail OUT of the unauthenticated response', async () => {
    const body = await health([
      { slug: 'off', enabled: false, failures: 50, lastRun: '2026-09-01T00:00:00.000Z' },
    ], false);
    expect(body).not.toHaveProperty('staleJobFailures');
    expect(body).not.toHaveProperty('consecutiveJobFailures');
  });
});
