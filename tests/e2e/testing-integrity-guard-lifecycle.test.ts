/**
 * Tier 3 for the Testing Integrity guard itself: the canonical evidence helper
 * must drive a route through a real AgentServer and emit proof only after the
 * exact live response is observed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { expectRouteAlive } from '../helpers/testingIntegrity.js';

describe('Testing Integrity guard — real route evidence lifecycle', () => {
  let temporaryRoot: string;
  let server: AgentServer;
  let proofFile: string;
  let proofNonce: string;
  const previousProofFile = process.env.INSTAR_TESTING_INTEGRITY_EVIDENCE_FILE;
  const previousNonce = process.env.INSTAR_TESTING_INTEGRITY_NONCE;

  beforeAll(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-integrity-e2e-'));
    const stateDir = path.join(temporaryRoot, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    const config: InstarConfig = {
      projectName: 'testing-integrity-e2e',
      projectDir: temporaryRoot,
      stateDir,
      port: 0,
      authToken: 'testing-integrity-token',
      requestTimeoutMs: 10_000,
      version: 'test',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 1,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5_000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    };

    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => sessionManager;
    server = new AgentServer({
      config,
      sessionManager,
      state: new StateManager(stateDir),
    });

    proofFile = previousProofFile ?? path.join(temporaryRoot, 'proof.jsonl');
    proofNonce = previousNonce ?? 'e2e-proof-nonce';
    process.env.INSTAR_TESTING_INTEGRITY_EVIDENCE_FILE = proofFile;
    process.env.INSTAR_TESTING_INTEGRITY_NONCE = proofNonce;
  });

  afterAll(async () => {
    await server.stop();
    if (previousProofFile === undefined) delete process.env.INSTAR_TESTING_INTEGRITY_EVIDENCE_FILE;
    else process.env.INSTAR_TESTING_INTEGRITY_EVIDENCE_FILE = previousProofFile;
    if (previousNonce === undefined) delete process.env.INSTAR_TESTING_INTEGRITY_NONCE;
    else process.env.INSTAR_TESTING_INTEGRITY_NONCE = previousNonce;
    SafeFsExecutor.safeRmSync(temporaryRoot, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/testing-integrity-guard-lifecycle.test.ts:cleanup',
    });
  });

  it('executes GET /ping through AgentServer and records the observed non-503 status', async () => {
    const response = await expectRouteAlive(server, {
      method: 'GET',
      routePath: '/ping',
      expectedStatus: 200,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    const proofLines = fs.readFileSync(proofFile, 'utf8').trim().split('\n');
    const proof = JSON.parse(proofLines[proofLines.length - 1]);
    expect(proof).toMatchObject({
      nonce: proofNonce,
      method: 'GET',
      path: '/ping',
      requestPath: '/ping',
      status: 200,
    });
  });

  it('rejects proof whose concrete request does not match the declared route', async () => {
    const before = fs.readFileSync(proofFile, 'utf8');

    await expect(expectRouteAlive(server, {
      method: 'GET',
      routePath: '/not-ping',
      requestPath: '/ping',
      expectedStatus: 200,
    })).rejects.toThrow(/does not match declared route/);

    expect(fs.readFileSync(proofFile, 'utf8')).toBe(before);
  });

  it('rejects proof whose concrete request method does not match the declared method', async () => {
    const before = fs.readFileSync(proofFile, 'utf8');

    await expect(expectRouteAlive(server, {
      method: 'POST',
      requestMethod: 'GET',
      routePath: '/ping',
      expectedStatus: 200,
    })).rejects.toThrow(/request method GET does not match declared method POST/);

    expect(fs.readFileSync(proofFile, 'utf8')).toBe(before);
  });

  it('executes an ALL route with a declared concrete request method', async () => {
    server.getApp().all('/testing-integrity-all', (_req, response) => response.status(204).end());

    await expectRouteAlive(server, {
      method: 'ALL',
      requestMethod: 'GET',
      routePath: '/testing-integrity-all',
      expectedStatus: 204,
      headers: { authorization: 'Bearer testing-integrity-token' },
    });

    const proofLines = fs.readFileSync(proofFile, 'utf8').trim().split('\n');
    expect(JSON.parse(proofLines[proofLines.length - 1])).toMatchObject({
      method: 'ALL',
      requestMethod: 'GET',
      path: '/testing-integrity-all',
      status: 204,
    });
  });
});
