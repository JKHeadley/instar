// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" test for SEC-170 part 1 of 2 (docs/specs/pool-wide-pin-budget.md).
 *
 * Boots the REAL AgentServer with a PinShareProvider for a five-machine agent and proves the share is
 * wired into POST /dashboard/unlock:
 *   - unknown browsers get this machine's share (4 of the agent's 20), not 20: the 5th unknown attempt
 *     is refused with today's 429, even with the right PIN;
 *   - a browser that unlocked before (honored marker) and a genuinely local request still unlock;
 *   - with the switch off, the same server keeps today's per-machine budget.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { PinShareProvider } from '../../src/core/PinShare.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PORT = 4042;
const PIN = '246813';
const TUNNEL_HOST = 'sec170-alive.trycloudflare.test';

function boot(tmpDir: string, enabled: boolean): { app: express.Express; share: PinShareProvider } {
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: PORT, projectName: 'e2e' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: PORT, authToken: 'sec170-e2e', dashboardPin: PIN,
    // Loose throttle so the share, not the per-source brakes, is what refuses.
    security: { pinThrottle: { enabled: true, globalFailureBudget: 100, coarseFailureBudget: 100, windowMs: 600000 } },
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: tmpDir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as unknown as InstarConfig;
  const share = new PinShareProvider({ stateDir, enabled: () => enabled, membership: () => ({ self: 'm_c', members: ['m_a', 'm_b', 'm_c', 'm_d', 'm_e'] }) });
  const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null }, state: new StateManager(stateDir), tunnel: { url: `https://${TUNNEL_HOST}` }, pinShare: share } as never);
  return { app: server.getApp(), share };
}

describe('SEC-170 — per-machine PIN share is alive on the unlock route', () => {
  let tmpOn: string;
  let tmpOff: string;
  let on: { app: express.Express; share: PinShareProvider };
  let off: { app: express.Express; share: PinShareProvider };

  beforeAll(() => {
    tmpOn = fs.mkdtempSync(path.join(os.tmpdir(), 'sec170-e2e-on-'));
    tmpOff = fs.mkdtempSync(path.join(os.tmpdir(), 'sec170-e2e-off-'));
    on = boot(tmpOn, true);
    off = boot(tmpOff, false);
  });
  afterAll(() => {
    for (const d of [tmpOn, tmpOff]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/sec170-pin-share-alive.test.ts' });
  });

  const tunnel = (app: express.Express, ip: string) => request(app).post('/dashboard/unlock')
    .set('Host', TUNNEL_HOST).set('cf-connecting-ip', ip).set('x-forwarded-proto', 'https');

  it('the switch on: this machine owns 4 of the 20, and stores it', () => {
    expect(on.share.share()).toBe(4);
    expect(on.share.state()).toMatchObject({ enabled: true, members: 5 });
  });

  it('a browser that unlocks now keeps working after the share is spent; the 5th unknown browser is refused; local still unlocks', async () => {
    const known = await tunnel(on.app, '198.51.100.7').send({ pin: PIN });
    expect(known.status).toBe(200);
    const cookie = String(known.headers['set-cookie'] ?? '').split(';')[0];
    expect(cookie).toContain('instar_pin_ok=');

    for (let i = 0; i < 4; i++) {
      const r = await tunnel(on.app, `203.0.113.${10 + i}`).send({ pin: '000000' });
      expect(r.status).toBe(403);
    }
    const stranger = await tunnel(on.app, '203.0.113.99').send({ pin: PIN });
    expect(stranger.status).toBe(429);

    const again = await tunnel(on.app, '198.51.100.7').set('Cookie', cookie).send({ pin: PIN });
    expect(again.status).toBe(200);
    const local = await request(on.app).post('/dashboard/unlock').set('Host', `127.0.0.1:${PORT}`).send({ pin: PIN });
    expect(local.status).toBe(200);
  });

  it('the switch off: the same five wrong guesses leave a new browser admitted (today\'s per-machine 20)', async () => {
    expect(off.share.share()).toBe(20);
    for (let i = 0; i < 5; i++) await tunnel(off.app, `192.0.2.${10 + i}`).send({ pin: '000000' });
    const stranger = await tunnel(off.app, '192.0.2.99').send({ pin: PIN });
    expect(stranger.status).toBe(200);
  });
});
