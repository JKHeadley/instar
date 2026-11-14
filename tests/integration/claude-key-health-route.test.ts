/** Tier 2: /health carries the key state only for an authenticated caller, and degrades while dead. */
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeKeyHealth, setActiveClaudeKeyHealth } from '../../src/core/ClaudeKeyHealth.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';

const KEY = `sk-ant-oat01-${'h'.repeat(40)}`;
const TOKEN = 'test-token';

describe('GET /health with a key agent', () => {
  let server: Server;
  let base = '';
  let health: ClaudeKeyHealth;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-key-route-'));

  beforeAll(async () => {
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const state = new StateManager(stateDir);
    const config = { projectName: 't', projectDir: dir, stateDir, port: 0, authToken: TOKEN, sessions: {} } as unknown as InstarConfig;
    health = new ClaudeKeyHealth({
      stateFile: path.join(stateDir, 'state', 'claude-key-health.json'),
      currentKey: () => KEY, currentRawKey: () => KEY, readKeyFromDisk: () => KEY, applyKey: () => {},
      probe: async () => 'rejected',
      notifyOperator: async () => true, notifyPerson: async () => true, listStuckSessions: async () => [],
      sessionLaunchFingerprint: () => null, refresh: async () => ({ ok: true }), clearLoginReports: () => {},
      report: () => {}, manualTimers: true,
    });
    setActiveClaudeKeyHealth(health);
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes({
      config, state, startTime: new Date(),
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null, updateChecker: null,
      autoUpdater: null, autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null,
      evolution: null, watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
      discoveryEvaluator: null,
      sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
    } as never));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    setActiveClaudeKeyHealth(null);
    health.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = async (authed: boolean) => (await fetch(`${base}/health`, authed ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {})).json() as Promise<Record<string, unknown>>;

  it('shows ok to an authenticated caller and nothing to the public', async () => {
    expect(((await get(true)).claudeKey as { status: string }).status).toBe('ok');
    expect((await get(false)).claudeKey).toBeUndefined();
  });

  it('reports dead and degraded after two refusals, and never the key', async () => {
    health.noteCallOutcome('rejected');
    await new Promise((res) => setTimeout(res, 10));
    await health.confirm();
    const body = await get(true);
    expect((body.claudeKey as { status: string }).status).toBe('dead');
    expect(body.status).toBe('degraded');
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
