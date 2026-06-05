// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Approval-as-Data ledger
 * (spec Part B / Phase 2) — GET/POST /approvals + /approvals/summary.
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses)
 * and verifies the routes are alive (200, not 503), Bearer-gated, and that the full
 * lifecycle works on the production path: record an approval → it shows in the
 * summary + list. WIRING-INTEGRITY: the production signer (HMAC over authToken) is
 * NOT a no-op — the persisted row's signature verifies against an independently
 * reconstructed HMAC, and a tampered row fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ApprovalLedger } from '../../src/core/ApprovalLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

function bootConfig(tmpDir: string, stateDir: string, auth: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

describe('Approval-as-Data ledger E2E lifecycle — feature is alive', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-approval-ledger';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-ledger-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config = bootConfig(tmpDir, stateDir, AUTH);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/approval-ledger-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /approvals/summary is alive (200, not 503) with a real summary shape', async () => {
    const res = await request(app).get('/approvals/summary').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.classes)).toBe(true);
    expect(typeof res.body.bySurface).toBe('object');
  });

  it('full lifecycle on the production path: POST records → summary + list reflect it', async () => {
    const post = await request(app).post('/approvals').set(auth()).send({
      subject: 'coordination-mandate', decisionClass: 'governance-safety', surface: 'chat', mode: 'approved-as-is',
    });
    expect(post.status).toBe(201);
    expect(post.body.row.mode).toBe('approved-as-is');

    const summary = await request(app).get('/approvals/summary').set(auth());
    expect(summary.body.total).toBe(1);
    const gov = summary.body.classes.find((c: any) => c.decisionClass === 'governance-safety');
    expect(gov.approvedAsIs).toBe(1);
    expect(summary.body.bySurface.chat.total).toBe(1);

    const list = await request(app).get('/approvals').set(auth());
    expect(list.body.rows[0].subject).toBe('coordination-mandate');
  });

  it('WIRING-INTEGRITY: the production HMAC signer is real — the persisted row verifies, a tamper fails', async () => {
    // The row recorded above is on disk, signed by the production signer
    // (HMAC over authToken). Reconstruct that signer independently and verify.
    const file = path.join(stateDir, 'state', 'approval-ledger.jsonl');
    const sign = (c: string) => createHmac('sha256', AUTH).update(c).digest('hex');
    const verifySig = (c: string, s: string) => {
      const e = sign(c);
      try { return e.length === s.length && timingSafeEqual(Buffer.from(e), Buffer.from(s)); } catch { return false; }
    };
    const independent = new ApprovalLedger({ filePath: file, sign, verifySig });
    const rows = independent.all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The signature is NOT a no-op: it verifies, and a mutated row does not.
    expect(independent.verify(rows[0])).toBe(true);
    expect(independent.verify({ ...rows[0], mode: 'rejected' })).toBe(false);
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/approvals/summary');
    expect(res.status).toBe(401);
  });

  it('rejects an operator-inconsistent row with 400 (change WITHOUT a divergence)', async () => {
    const res = await request(app).post('/approvals').set(auth()).send({
      subject: 'x', decisionClass: 'k', surface: 'chat', mode: 'approved-with-change',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requires at least one divergence/);
  });
});
