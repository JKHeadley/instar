// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the ReviewExchange protocol
 * (coordination-mandate spec §7 G2.3).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses)
 * and proves, on the production init path:
 *   1. The routes are alive (200, not 503) and Bearer-gated.
 *   2. DENY-BY-DEFAULT inherited: with no mandate, the peer sign-off refuses (403).
 *   3. The full production lifecycle: PIN-issued mandate → create exchange →
 *      delivered → peer approve (gated) → owner sign (gated) → COMPLETE, with both
 *      signatures' audit hashes resolving to allow entries in the intact chain.
 *   4. WIRING-INTEGRITY: the engine persists to the production state path and the
 *      exchange's signatures reference REAL audit entries (not a no-op gate).
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
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

const AUTH = 'test-e2e-review-exchange';
const PIN = '424242';
const ECHO = 'fp-echo';
const DAWN = 'fp-dawn';
const FUTURE = '2999-01-01T00:00:00Z';
const SHA = 'c'.repeat(64);

describe('ReviewExchange E2E lifecycle — feature is alive + mandate-gated mutual sign-off', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      dashboardPin: PIN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/review-exchange-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /review-exchange is alive (200, not 503) and Bearer-gated', async () => {
    expect((await request(app).get('/review-exchange')).status).toBe(401);
    const res = await request(app).get('/review-exchange').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.exchanges).toEqual([]);
  });

  it('DENY-BY-DEFAULT inherited: with no mandate, the peer sign-off refuses on the production path', async () => {
    const created = await request(app).post('/review-exchange').set(auth()).send({
      mandateId: 'ghost-mandate', artifact: 'migration-port',
      packageRef: 'docs/feedback-migration-phase1-review-package.md',
      packageSha256: SHA, parties: [ECHO, DAWN], id: 'rex-deny',
    });
    expect(created.status).toBe(201);
    await request(app).post('/review-exchange/rex-deny/delivered').set(auth()).send({ evidence: 'tl-0' });
    const res = await request(app).post('/review-exchange/rex-deny/peer-verdict').set(auth()).send({
      verdict: 'approve', summary: 's', evidence: 'tl-1', peerFp: DAWN,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/mandate denied/);
  });

  it('full production lifecycle: PIN-issued mandate → exchange completes with two gate-authorized signatures, audit chain intact', async () => {
    // Issue the A/A/B first-mandate shape (PIN-gated, the human surface).
    const issued = await request(app).post('/mandate/issue').set(auth()).send({
      pin: PIN, scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: [
        { action: 'exchange-read-credential', bounds: { credentialScope: 'read-only', onMachine: true } },
        { action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } },
      ],
      expiresAt: FUTURE,
    });
    expect(issued.status).toBe(201);
    const mandateId = issued.body.mandate.id;

    // Create → deliver → peer approve → owner sign.
    const created = await request(app).post('/review-exchange').set(auth()).send({
      mandateId, artifact: 'migration-port',
      packageRef: 'docs/feedback-migration-phase1-review-package.md',
      packageSha256: SHA, parties: [ECHO, DAWN], id: 'rex-live',
    });
    expect(created.status).toBe(201);

    expect((await request(app).post('/review-exchange/rex-live/delivered').set(auth())
      .send({ evidence: 'threadline-msg-42' })).status).toBe(200);

    const verdict = await request(app).post('/review-exchange/rex-live/peer-verdict').set(auth()).send({
      verdict: 'approve', summary: 'port reviewed — four scars verified', evidence: 'threadline-msg-43', peerFp: DAWN,
    });
    expect(verdict.status).toBe(200);
    expect(verdict.body.exchange.state).toBe('verdict-recorded');

    const signed = await request(app).post('/review-exchange/rex-live/sign').set(auth()).send({ agentFp: ECHO });
    expect(signed.status).toBe(200);
    expect(signed.body.exchange.state).toBe('complete');
    expect(signed.body.exchange.signatures).toHaveLength(2);

    // WIRING-INTEGRITY: both signatures' audit hashes resolve to REAL allow entries
    // in the production audit chain — the gate the engine used is not a no-op.
    const audit = await request(app).get('/mandate/audit').set(auth());
    expect(audit.body.chain).toEqual({ ok: true });
    const hashes = new Set(audit.body.entries.filter((e: any) => e.decision === 'allow').map((e: any) => e.hash));
    for (const s of signed.body.exchange.signatures) {
      expect(hashes.has(s.auditHash)).toBe(true);
    }

    // The engine persisted to the production state path (.instar/state/ convention).
    const file = path.join(stateDir, 'state', 'review-exchanges.json');
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.find((r: any) => r.id === 'rex-live')?.state).toBe('complete');
  });

  it('the operator kill switch reaches the protocol: revoking the mandate blocks further sign-offs', async () => {
    // New exchange under the same mandate, then revoke before the peer verdict.
    const { body } = await request(app).get('/mandate').set(auth());
    const mandateId = body.mandates[0].id;
    await request(app).post('/review-exchange').set(auth()).send({
      mandateId, artifact: 'migration-port', packageRef: 'pkg', packageSha256: SHA,
      parties: [ECHO, DAWN], id: 'rex-revoked',
    });
    await request(app).post('/review-exchange/rex-revoked/delivered').set(auth()).send({ evidence: 'tl-9' });
    expect((await request(app).post(`/mandate/${mandateId}/revoke`).set(auth())
      .send({ pin: PIN, reason: 'e2e kill-switch' })).status).toBe(200);
    const res = await request(app).post('/review-exchange/rex-revoked/peer-verdict').set(auth()).send({
      verdict: 'approve', summary: 's', evidence: 'tl-10', peerFp: DAWN,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/revoked/);
  });
});
