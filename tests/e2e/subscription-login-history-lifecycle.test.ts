// safe-fs-allow: test file — SafeFsExecutor owns temp cleanup.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('subscription sign-in history E2E lifecycle (feature is alive)', () => {
  let root: string;
  let server: AgentServer;
  const authToken = 'subscription-ledger-e2e';

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-ledger-e2e-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    const config = {
      projectName: 'ledger-e2e', projectDir: root, stateDir, port: 0, authToken,
      requestTimeoutMs: 10_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    const pool = new SubscriptionPool({ stateDir, machineId: 'e2e-machine' });
    const ledger = new SubscriptionLoginLedger({ stateDir, machineId: 'e2e-machine', writeEnabled: true });
    ledger.recordStatus({
      accountId: 'acct-1', status: 'needs-reauth', at: new Date().toISOString(),
      causeClass: 'exchange-failed', corroboration: 'exchange-corroborated',
    });
    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
      state: new StateManager(stateDir),
      subscriptionPool: pool,
      subscriptionLoginLedger: ledger,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'subscription-login-history-lifecycle:cleanup' });
  });

  it('serves the separated summary through the real AgentServer route lifecycle', async () => {
    const response = await request(server.getApp())
      .get('/subscription-pool/login-history?summary=1&days=7')
      .set({ Authorization: `Bearer ${authToken}` });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      authority: { state: 'unconfigured' },
      health: { state: 'ok' },
      summary: {
        statusEpisodes: { total: 1, open: 1 },
        credentialReadObservationWindows: {
          total: 0, evidenceMaturity: 'provisional-credential-read', floorPasses: 3, floorMinutes: 30,
        },
      },
    });
  });

  it('requires normal server authentication', async () => {
    expect((await request(server.getApp()).get('/subscription-pool/login-history')).status).toBe(401);
  });
});
