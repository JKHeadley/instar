// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Blocker lifecycle throughput count E2E (feature is alive)', () => {
  const AUTH = 'blocker-throughput-e2e';
  let tmp = '';
  let server: AgentServer;
  let tracker: CommitmentTracker;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-throughput-e2e-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'server-data'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');

    const todayStart = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const seed = new BlockerLifecycleLedger({ dbPath: path.join(stateDir, 'server-data', 'blocker-lifecycle.db') });
    [1, 1, 1, 3, 4, 5].forEach((count, dayIndex) => {
      const observedAtMs = todayStart - (6 - dayIndex) * 86_400_000 + 1_000;
      for (let i = 0; i < count; i++) seed.record({ origin: 'e2e', factor: 'deliverable-completion',
        sourceEventId: `seed-${dayIndex}-${i}`, observedAtMs, latencyMs: null, outcome: 'observed' }, true);
    });
    seed.close();

    tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir),
      blockerLifecycleEnabled: true, originMachineId: 'e2e' });
    const config = { projectName: 'e2e', projectDir: tmp, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10_000, version: '0', developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
      monitoring: { blockerLifecycleLedger: { enabled: true } } } as unknown as InstarConfig;
    server = new AgentServer({ config, commitmentTracker: tracker,
      sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
      state: new StateManager(stateDir) });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true,
      operation: 'tests/e2e/blocker-throughput-count-alive.test.ts' });
  });

  it('serves an exact live non-zero count and a climbing drive trend through the real routes', async () => {
    const c = tracker.record({ userRequest: 'ship live e2e deliverable', agentResponse: 'shipping',
      type: 'one-time-action', verificationMethod: 'manual' });
    expect(tracker.deliver(c.id)).not.toBeNull();
    await new Promise(resolve => setImmediate(resolve));

    const summary = await request(server.getApp()).get('/blocker-lifecycle/summary?sinceHours=168&scope=local')
      .set({ Authorization: `Bearer ${AUTH}` });
    expect(summary.status).toBe(200);
    expect(summary.body.schemaVersion).toBe(2);
    const count = summary.body.origins[0].factors.find((row: { factor: string }) => row.factor === 'deliverable-completion');
    expect(count).toMatchObject({ factor: 'deliverable-completion', unit: 'count', total: 16,
      completed: 16, missing: 0, excluded: 0, coverage: 1,
      window: { kind: 'rolling-hours', hours: 168 } });

    const trend = await request(server.getApp()).get('/blocker-lifecycle/trend?windowDays=7&scope=local')
      .set({ Authorization: `Bearer ${AUTH}` });
    expect(trend.status).toBe(200);
    const climbing = trend.body.origins[0].factors.find((row: { factor: string }) => row.factor === 'deliverable-completion');
    expect(climbing).toMatchObject({ factor: 'deliverable-completion', unit: 'count', direction: 'climbing',
      window: { kind: 'rolling-days', days: 7, dailyBuckets: 'utc', currentDay: 'partial' },
      windowTotal: 16, currentDayCount: 1,
      firstHalf: { total: 3, meanPerDay: 1 }, secondHalf: { total: 12, meanPerDay: 4 }, ratio: 4 });
  });

  it('keeps the surface authenticated', async () => {
    expect((await request(server.getApp()).get('/blocker-lifecycle/summary')).status).toBe(401);
  });
});
