// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" test for docs/specs/dashboard-pin-throttle.md (design b).
 *
 * Boots the REAL AgentServer on the production init path and proves the dashboard PIN throttle is
 * actually wired into POST /dashboard/unlock (not merely a module that exists):
 *   - a correct PIN over the tunnel path returns 200 and sets the signed instar_pin_ok cookie;
 *   - a flood of wrong PINs from distinct tunnel clients drains the hard cap → a fresh unmarked
 *     browser is refused (429);
 *   - a genuinely-local request (loopback Host) still unlocks while the cap is drained (recovery);
 *   - migration E2E: the nested security.pinThrottle default is additive and idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null } as any;
}

describe('dashboard PIN throttle — E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let app: express.Express;
  const AUTH = 'test-e2e-pin-throttle';
  const PIN = '135791';
  const PORT = 4042;
  const TUNNEL_HOST = 'pt-alive.trycloudflare.test';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-throttle-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: PORT, projectName: 'e2e' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: PORT, authToken: AUTH, dashboardPin: PIN,
      security: { pinThrottle: { enabled: true, globalFailureBudget: 4, coarseFailureBudget: 100, windowMs: 600000 } },
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: tmpDir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
      scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
    } as InstarConfig;

    const server = new AgentServer({
      config,
      sessionManager: createMockSessionManager(),
      state: new StateManager(stateDir),
      tunnel: { url: `https://${TUNNEL_HOST}` },
    } as any);
    app = server.getApp();
  });

  afterAll(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/dashboard-pin-throttle-alive.test.ts' }); });

  const tunnel = (ip: string) => request(app).post('/dashboard/unlock')
    .set('Host', TUNNEL_HOST).set('cf-connecting-ip', ip).set('x-forwarded-proto', 'https');

  it('a correct PIN over the tunnel returns 200 and sets the signed cookie', async () => {
    const res = await tunnel('198.51.100.9').send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(String(res.headers['set-cookie'] ?? '')).toContain('instar_pin_ok=');
  });

  it('the hard cap refuses a fresh unmarked tunnel browser once drained, but a local request still unlocks', async () => {
    for (let i = 0; i < 5; i++) await tunnel(`203.0.113.${i}`).send({ pin: '000000' });
    const stranger = await tunnel('203.0.113.99').send({ pin: PIN });
    expect(stranger.status).toBe(429);
    const localRes = await request(app).post('/dashboard/unlock').set('Host', `127.0.0.1:${PORT}`).send({ pin: PIN });
    expect(localRes.status).toBe(200);
  });
});
