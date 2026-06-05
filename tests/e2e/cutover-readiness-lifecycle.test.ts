// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the cutover-readiness checker
 * (coordination-mandate spec §7 G2.4, decision 1A).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer and proves, on the
 * production init path:
 *   1. /cutover-readiness is alive (200, not 503) and Bearer-gated, door manual.
 *   2. WIRING-INTEGRITY (the load-bearing one): the mandate conditions
 *      `integrity-gate-pass` + `parity-zero-divergence` resolve from REAL durable
 *      state — a conditioned execute-cutover authority DENIES on a fresh boot,
 *      and flips to ALLOW only after the durable state genuinely clears (parity
 *      passes pre-seeded on disk + the integrity report written through the
 *      production-path readiness instance). No agent assertion anywhere (T7).
 *   3. POST /cutover-readiness/parity-pass without a configured source → 409.
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

const AUTH = 'test-e2e-cutover-readiness';
const PIN = '424242';
const ECHO = 'fp-echo';
const DAWN = 'fp-dawn';
const FUTURE = '2999-01-01T00:00:00Z';
const HOUR = 60 * 60 * 1000;

describe('Cutover-readiness E2E lifecycle — alive + conditions resolve from REAL durable state', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutready-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // Pre-seed the DURABLE parity window on disk BEFORE boot: 3 clean passes
    // spanning >1h, the last one fresh (now). The production boot loads these —
    // exactly how a real window survives a restart.
    const now = Date.now();
    const passes = [now - 2 * HOUR, now - HOUR, now].map((t) => JSON.stringify({
      at: new Date(t).toISOString(), clustersCompared: 1346, divergences: 0, divergent: false,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'state', 'feedback-parity-passes.jsonl'), passes);

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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/cutover-readiness-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /cutover-readiness is alive (200, not 503), Bearer-gated, door manual; parity loaded from disk', async () => {
    expect((await request(app).get('/cutover-readiness')).status).toBe(401);
    const res = await request(app).get('/cutover-readiness').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.door).toBe('manual-operator-click');
    // The pre-seeded durable window was loaded on the production path.
    expect(res.body.parity.cleared).toBe(true);
    expect(res.body.parity.stale).toBe(false);
    // Integrity never ran → not ready (deny-safe composition).
    expect(res.body.integrity.ran).toBe(false);
    expect(res.body.ready).toBe(false);
  });

  it('WIRING-INTEGRITY: a conditioned execute-cutover DENIES until the REAL durable state clears, then ALLOWS', async () => {
    // Issue a mandate whose execute-cutover requires BOTH objective conditions.
    const issued = await request(app).post('/mandate/issue').set(auth()).send({
      pin: PIN, scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: [{
        action: 'execute-cutover', bounds: {},
        requiresCondition: 'integrity-gate-pass+parity-zero-divergence',
      }],
      expiresAt: FUTURE,
    });
    expect(issued.status).toBe(201);
    const mandateId = issued.body.mandate.id;

    // Parity is green (pre-seeded) but integrity NEVER ran → condition false → deny.
    const denied = await request(app).post('/mandate/evaluate').set(auth()).send({
      action: 'execute-cutover', params: {}, agentFp: ECHO, mandateId,
    });
    expect(denied.body.decision).toBe('deny');
    expect(denied.body.conditionResult).toBe(false);

    // Write a PASSED integrity report into the production state path — the
    // server-side artifact the import tooling produces. NO server restart:
    // integrityStatus() reads durable state per evaluation.
    fs.writeFileSync(path.join(stateDir, 'state', 'feedback-integrity-report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      report: {
        fingerprintCollisions: [], schemaDivergences: [], checksumMismatches: [],
        danglingRefs: [], sequenceResetTo: 1347, passed: true,
      },
    }));

    // Same evaluation now ALLOWS — the condition flipped from REAL durable state.
    const allowed = await request(app).post('/mandate/evaluate').set(auth()).send({
      action: 'execute-cutover', params: {}, agentFp: ECHO, mandateId,
    });
    expect(allowed.body.decision).toBe('allow');
    expect(allowed.body.conditionResult).toBe(true);

    // And the readiness surface agrees end-to-end.
    const ready = await request(app).get('/cutover-readiness').set(auth());
    expect(ready.body.ready).toBe(true);

    // A FAILED report re-blocks (both sides of the boundary).
    fs.writeFileSync(path.join(stateDir, 'state', 'feedback-integrity-report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      report: {
        fingerprintCollisions: [], schemaDivergences: [],
        checksumMismatches: [{ kind: 'cluster', id: 'c1', sourceChecksum: 'a', targetChecksum: 'b' }],
        danglingRefs: [], sequenceResetTo: 1347, passed: false,
      },
    }));
    const reblocked = await request(app).post('/mandate/evaluate').set(auth()).send({
      action: 'execute-cutover', params: {}, agentFp: ECHO, mandateId,
    });
    expect(reblocked.body.decision).toBe('deny');
  });

  it('POST /cutover-readiness/parity-pass with no parity source configured → 409, nothing recorded', async () => {
    const res = await request(app).post('/cutover-readiness/parity-pass').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no parity source configured/);
  });

  it('import-dryrun routes are ALIVE on the production path (Bearer-gated; 409 without a source — not 404, not 503)', async () => {
    // Feature-is-alive: the trigger route exists and is wired through the
    // production init. With no feedbackMigration.paritySource configured the
    // rehearsal REFUSES (409) — proving the handler ran, not that routing failed.
    expect((await request(app).post('/cutover-readiness/import-dryrun')).status).toBe(401);
    const res = await request(app).post('/cutover-readiness/import-dryrun').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no import source configured/);

    // The read surface is alive too and reads never-ran (deny-safe default).
    const read = await request(app).get('/cutover-readiness/import-dryrun').set(auth());
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ran: false, passed: false });

    // And the composed status carries the importDryRun leg end-to-end.
    const status = await request(app).get('/cutover-readiness').set(auth());
    expect(status.body.importDryRun).toMatchObject({ ran: false, passed: false });
  });
});
