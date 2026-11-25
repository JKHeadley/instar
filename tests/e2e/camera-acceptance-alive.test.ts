import { describe, it, expect, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { CameraPassWithdrawal, CameraPassWithdrawalJournal, CameraRequestJournal } from '../../src/core/CameraAcceptanceRequests.js';
import type { CameraAcceptanceReceipt } from '../../src/core/CameraOwnerAcceptance.js';

const AUTH = 'test-e2e-cos';
const tmpDirs: string[] = [];

function mkConfig(): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-acceptance-e2e-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}
const sm = () => ({ listRunningSessions: () => [], getSession: () => null }) as never;
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/camera-acceptance-alive.test.ts' }); });

describe('Camera verifier request HTTP wiring', () => {
  const route = '/chief-of-staff/camera-acceptance/requests';
  const originHeader = 'X-Instar-Origin-Session';
  const verifierToken = 'ior1_' + 'v'.repeat(43);

  it('holds when the Camera pilot has no runtime', async () => {
    const { config, stateDir } = mkConfig();
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir) });
    await server.start();
    try {
      await request(server.getApp()).post(route).set(auth()).expect(503);
    } finally { await server.stop(); }
  });

  it('requires the verifier session and only acknowledges an issued journal request', async () => {
    const { config, stateDir } = mkConfig();
    const appendRequest = vi.fn(async () => {});
    const journal: CameraRequestJournal & CameraPassWithdrawalJournal = {
      withWriteLock: operation => operation({
        requirement: { candidate: 'camera-build', revision: 1, verifier: 'reviewer', builders: ['builder'] },
        receipts: [], appendRequest, findWithdrawal: () => null, appendWithdrawal: async () => {},
      }),
    };
    const resolveVerifier = vi.fn(async (credential: string) => credential === verifierToken
      ? { principal: 'reviewer', journal } : null);
    const server = new AgentServer({
      config, sessionManager: sm(), state: new StateManager(stateDir), cameraAcceptance: { resolveVerifier },
    });
    await server.start();
    try {
      await request(server.getApp()).post(route).set(originHeader, verifierToken).expect(401);
      await request(server.getApp()).post(route).set(auth()).expect(403);
      expect(resolveVerifier).not.toHaveBeenCalled();
      await request(server.getApp()).post(route).set(auth()).set(originHeader, 'ior1_' + 'w'.repeat(43)).expect(403);
      expect(appendRequest).not.toHaveBeenCalled();
      const issued = await request(server.getApp()).post(route).set(auth()).set(originHeader, verifierToken).expect(201);
      expect(issued.body).toEqual({ requestId: expect.any(String) });
      expect(appendRequest).toHaveBeenCalledWith(expect.objectContaining({ id: issued.body.requestId, verifier: 'reviewer' }));
      appendRequest.mockRejectedValueOnce(new Error('write did not reach disk'));
      await request(server.getApp()).post(route).set(auth()).set(originHeader, verifierToken).expect(503);
    } finally { await server.stop(); }
  });
});

describe('Camera Pass withdrawal HTTP wiring', () => {
  it('validates the body and records an exact withdrawal once before a retest', async () => {
    const { config, stateDir } = mkConfig();
    const token = 'ior1_' + 'v'.repeat(43);
    const withdrawal = { id: 'test-withdrawal', candidate: 'camera-build', revision: 1, passSequence: 1, reason: 'retest' } as const;
    const reqPath = '/chief-of-staff/camera-acceptance/requests';
    const withdrawalPath = '/chief-of-staff/camera-acceptance/pass-withdrawals';
    const headers = { ...auth(), 'X-Instar-Origin-Session': token };
    const requirement = { candidate: 'camera-build', revision: 1, verifier: 'reviewer', builders: ['builder'] };
    const receipts: CameraAcceptanceReceipt[] = [
      { candidate: requirement.candidate, revision: 1, verifier: 'reviewer', sequence: 1, decision: 'pass' },
    ];
    let stored: { input: CameraPassWithdrawal; receipt: CameraAcceptanceReceipt } | null = null;
    const appendWithdrawal = vi.fn(async (entry: { input: CameraPassWithdrawal; receipt: CameraAcceptanceReceipt }) => {
      stored = entry;
      receipts.push(entry.receipt);
    });
    const journal: CameraRequestJournal & CameraPassWithdrawalJournal = {
      withWriteLock: operation => operation({
        requirement, receipts, appendRequest: async () => {},
        findWithdrawal: id => stored?.input.id === id ? stored : null,
        appendWithdrawal,
      }),
    };
    const server = new AgentServer({
      config, sessionManager: sm(), state: new StateManager(stateDir),
      cameraAcceptance: { resolveVerifier: async credential => credential === token ? { principal: 'reviewer', journal } : null },
    });
    await server.start();
    try {
      await request(server.getApp()).post(reqPath).set(headers).expect(409);
      await request(server.getApp()).post(withdrawalPath).set(auth()).send(withdrawal).expect(403);
      await request(server.getApp()).post(withdrawalPath).set(headers).send({ ...withdrawal, unknown: true }).expect(400);
      const result = await request(server.getApp()).post(withdrawalPath).set(headers).send(withdrawal).expect(200);
      expect(result.body).toEqual({ decision: 'pending', sequence: 2 });
      await request(server.getApp()).post(withdrawalPath).set(headers).send(withdrawal).expect(200);
      await request(server.getApp()).post(withdrawalPath).set(headers).send({ ...withdrawal, reason: 'regression' }).expect(409);
      expect(appendWithdrawal).toHaveBeenCalledTimes(1);
      await request(server.getApp()).post(reqPath).set(headers).expect(201);
    } finally { await server.stop(); }
  });
});
