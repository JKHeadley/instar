// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests (Tier 2) — the feedback-factory processing HTTP surface
 * (spec §191) over a REAL booted AgentServer (the production init path):
 *
 *   GET  /feedback-factory/stats   — read-only counts over the canonical store
 *   POST /feedback-factory/process — one clustering pass (appends local JSONL)
 *
 * Proves the routes are Bearer-gated, dev-gated (503 dark / 200 live), and that
 * the live route delegates to the REAL on-disk JsonlFeedbackStore (a seeded row
 * is counted in stats and clustered by the process trigger — not a stub).
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

const AUTH = 'test-ff-stats';

function baseConfig(tmpDir: string, stateDir: string): InstarConfig {
  return {
    projectName: 'it', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

function mkStateDir(): { tmpDir: string; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-stats-it-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'it' }));
  return { tmpDir, stateDir };
}

function seedStore(stateDir: string, rows: Array<Record<string, unknown>>): void {
  const dir = path.join(stateDir, 'state', 'feedback-factory', 'store');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'feedback.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

describe('feedback-factory processing routes — DARK on the fleet', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    const dirs = mkStateDir();
    tmpDir = dirs.tmpDir;
    // NO developmentAgent, NO explicit enabled → gate resolves dark.
    const config = baseConfig(tmpDir, dirs.stateDir);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(dirs.stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/feedback-factory-stats-route.test.ts' });
  });

  it('GET /feedback-factory/stats is Bearer-gated and 503s when dark', async () => {
    expect((await request(app).get('/feedback-factory/stats')).status).toBe(401);
    const res = await request(app).get('/feedback-factory/stats').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('feedback-factory');
  });

  it('POST /feedback-factory/process is Bearer-gated and 503s when dark', async () => {
    expect((await request(app).post('/feedback-factory/process')).status).toBe(401);
    const res = await request(app).post('/feedback-factory/process').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('feedback-factory');
  });
});

describe('feedback-factory processing routes — LIVE on a development agent (real store)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    const dirs = mkStateDir();
    tmpDir = dirs.tmpDir;
    stateDir = dirs.stateDir;
    // Seed the canonical store BEFORE boot with three unprocessed reports.
    seedStore(stateDir, [
      { feedbackId: 'fb-1', title: 'gitsync pull fails', description: 'times out under load repeatedly', type: 'bug', status: 'unprocessed', receivedAt: '2026-05-01T00:00:00Z' },
      { feedbackId: 'fb-2', title: 'gitsync pull fails', description: 'times out under load repeatedly', type: 'bug', status: 'unprocessed', receivedAt: '2026-05-01T01:00:00Z' },
      { feedbackId: 'fb-3', title: 'csv export drops a row', description: 'last row missing on export', type: 'bug', status: 'unprocessed', receivedAt: '2026-05-02T00:00:00Z' },
    ]);
    const config = { ...baseConfig(tmpDir, stateDir), developmentAgent: true } as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/feedback-factory-stats-route.test.ts' });
  });

  it('GET /feedback-factory/stats is ALIVE (200) and reflects the seeded on-disk store', async () => {
    const res = await request(app).get('/feedback-factory/stats').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, clusterCount: 0, dispatchCount: 0 });
    expect(res.body.byStatus).toEqual({ unprocessed: 3 });
    expect(res.body.lastWriteAt).toBe('2026-05-02T00:00:00Z');
  });

  it('POST /feedback-factory/process clusters the backlog and the stats route shows the change', async () => {
    const proc = await request(app).post('/feedback-factory/process').set({ Authorization: `Bearer ${AUTH}` });
    expect(proc.status).toBe(200);
    expect(proc.body.processed).toBe(3);
    expect(proc.body.metrics).toMatchObject({ captured: 3 });
    // Two clusters: the gitsync pair merges, the csv bug is its own.
    expect(proc.body.stats.clusterCount).toBe(2);
    expect(proc.body.stats.byStatus.unprocessed ?? 0).toBe(0);
    expect(proc.body.stats.byStatus.processing).toBe(3);

    // The read route now reflects the mutated store.
    const after = await request(app).get('/feedback-factory/stats').set({ Authorization: `Bearer ${AUTH}` });
    expect(after.body.clusterCount).toBe(2);
    expect(after.body.byStatus.processing).toBe(3);
  });

  it('POST /feedback-factory/process is idempotent — a second pass processes nothing', async () => {
    const again = await request(app).post('/feedback-factory/process').set({ Authorization: `Bearer ${AUTH}` });
    expect(again.status).toBe(200);
    expect(again.body.processed).toBe(0);
  });
});
