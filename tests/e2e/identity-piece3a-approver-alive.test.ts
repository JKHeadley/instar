/**
 * The approver mark in the owner record is ALIVE through the production wiring (identity-security piece 3a;
 * Testing Integrity Phase 1): AgentServer runs the kept-device migration at boot and hands the owner-record sync
 * its hooks; the claim and grant routes are mounted (they answer, not 404); the presence-key route refuses a
 * device that can't approve.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import * as ownerRecordWiring from '../../src/core/ownerRecordWiring.js';
import { resetApproverStateCacheForTests } from '../../src/server/mobileApprover.js';

const AUTH = 'test-approver-alive';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3a-alive-'));
afterEach(() => { ownerRecordWiring.resetOwnerRecordWiringForTests(); resetApproverStateCacheForTests(); });
afterAll(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/identity-piece3a-approver-alive.test.ts:cleanup' }); });

function config(dir: string): InstarConfig {
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'p3a', agentName: 'P3A' }));
  return {
    projectName: 'p3a', projectDir: dir, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.10.3',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    mobilePairing: { enabled: true, multiRoute: { enabled: false } },
  } as InstarConfig;
}

describe('approver mark lifecycle (production wiring)', () => {
  it('AgentServer wires the migration and the sync hooks', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server/AgentServer.ts'), 'utf8');
    expect(src).toContain('ensureApproverMigration(mp);');
    expect(src).toContain('setOwnerRecordApproverHooks({');
    const routes = fs.readFileSync(path.join(__dirname, '../../src/server/mobilePairingRoutes.ts'), 'utf8');
    expect(routes).toContain('mountApproverClaimRoutes(router, svc);');
    expect(routes).toContain('mountApproverGrantRoutes(router, svc);');
    expect(routes).toContain('mountApproverRecoveryRoutes(router, svc);'); // piece 3d
    expect(src).toContain('setOwnerRecordRecoveryHooks(recoveryHooksFor(mp));');
    // throwaway-owner-chat: the reset command sits on every owner-chat surface (the adapter, or the stand-in).
    expect(src).toContain('chat.approverResetHandler = (args) => approverResetCommand(mp, args);');
    expect(src).toContain("standIn.onShutOff('recovery',");
    expect(src).toContain("standIn.onShutOff('approver-claim',");
  });

  it('is alive: boot runs the migration, and the approver routes answer (not 404)', async () => {
    const cfg = config(path.join(tmp, 'alive'));
    ownerRecordWiring.wireOwnerRecordStore(cfg as never, new MachineIdentityManager(cfg.stateDir));
    const server = new AgentServer({ config: cfg, sessionManager: createMockSessionManager() as never, state: new StateManager(cfg.stateDir), ownerRecord: ownerRecordWiring.ownerRecordRouteDeps });
    const stateFile = path.join(cfg.stateDir, 'state', 'mobile-approver-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).migration).toMatchObject({ kept: [], cutoffConfirmed: true });
    for (const [method, url] of [['post', '/mobile/approver/first'], ['post', '/mobile/approver/request'], ['get', '/mobile/approver/requests'], ['post', '/mobile/approver/recovery/stop'], ['post', '/mobile/approver/recovery/finish']] as const) {
      const r = await (method === 'get' ? request(server.getApp()).get(url) : request(server.getApp()).post(url).send({})).set({ Authorization: `Bearer ${AUTH}` });
      expect(r.status, `${method} ${url}: ${JSON.stringify(r.body)}`).not.toBe(404);
      expect([401, 403]).toContain(r.status); // the bearer is not a device: refused by the route, never "not found"
    }
  });
});
