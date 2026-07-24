// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" + WIRING-INTEGRITY — feedback-factory processing
 * (feedback-factory-migration spec §191: "the processor job is actually
 * constructed and scheduled, not dead code").
 *
 * Two halves, both on the production path:
 *
 *   A. Route alive: boot the REAL AgentServer (the path server.ts uses). DARK by
 *      default (no developmentAgent → 503); ALIVE on a development agent (200,
 *      not 503), delegating to the REAL on-disk JsonlFeedbackStore.
 *
 *   B. Wiring integrity (§191): install the SHIPPED feedback-factory-process job
 *      template through the REAL installBuiltinJobs path and prove the loader
 *      constructs a scheduled JobDefinition from it — it is not dead code. The job
 *      ships disabled (operator opt-in), but a disabled built-in still loads as a
 *      real scheduled definition (the per-slug precedence rule), so the cadence
 *      machinery genuinely knows about it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { loadAgentMdJobs, validateManifest } from '../../src/scheduler/AgentMdJobLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const AUTH = 'test-ff-process-e2e';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

function baseConfig(tmpDir: string, stateDir: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

function mkStateDir(prefix: string): { tmpDir: string; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e' }));
  return { tmpDir, stateDir };
}

// ── A. ROUTE ALIVE ─────────────────────────────────────────────────────────

describe('feedback-factory processing E2E — dark by default (production init path)', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    const dirs = mkStateDir('ff-proc-e2e-dark-');
    tmpDir = dirs.tmpDir;
    const config = baseConfig(tmpDir, dirs.stateDir); // no developmentAgent → gate dark
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(dirs.stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/feedback-factory-process-lifecycle.test.ts' });
  });

  it('both routes 503 when dark (deny-safe)', async () => {
    const stats = await request(app).get('/feedback-factory/stats').set({ Authorization: `Bearer ${AUTH}` });
    expect(stats.status).toBe(503);
    const proc = await request(app).post('/feedback-factory/process').set({ Authorization: `Bearer ${AUTH}` });
    expect(proc.status).toBe(503);
  });
});

describe('feedback-factory processing E2E — ALIVE on a development agent (production init path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    const dirs = mkStateDir('ff-proc-e2e-live-');
    tmpDir = dirs.tmpDir;
    stateDir = dirs.stateDir;
    // Seed one unprocessed report at the production-default store dir.
    const storeDir = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, 'feedback.jsonl'),
      JSON.stringify({ feedbackId: 'fb-e2e', title: 'alive title', description: 'a sufficiently long description', type: 'bug', status: 'unprocessed', receivedAt: '2026-05-01T00:00:00Z' }) + '\n',
      'utf8',
    );
    const config = { ...baseConfig(tmpDir, stateDir), developmentAgent: true } as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/feedback-factory-process-lifecycle.test.ts' });
  });

  it('GET /feedback-factory/stats is ALIVE (200, not 503) and reads the real store', async () => {
    const res = await request(app).get('/feedback-factory/stats').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.byStatus).toEqual({ unprocessed: 1 });
  });

  it('POST /feedback-factory/process is ALIVE and mutates the real on-disk store', async () => {
    const proc = await request(app).post('/feedback-factory/process').set({ Authorization: `Bearer ${AUTH}` });
    expect(proc.status).toBe(200);
    expect(proc.body.processed).toBe(1);

    // WIRING INTEGRITY (not a no-op): the durable clusters.jsonl now exists with a row.
    const clustersFile = path.join(stateDir, 'state', 'feedback-factory', 'store', 'clusters.jsonl');
    expect(fs.existsSync(clustersFile)).toBe(true);
    const clusterContent = fs.readFileSync(clustersFile, 'utf8').trim();
    expect(clusterContent.length).toBeGreaterThan(0);
    // The feedback row was flipped unprocessed→processing on disk.
    const fbContent = fs.readFileSync(path.join(stateDir, 'state', 'feedback-factory', 'store', 'feedback.jsonl'), 'utf8');
    const lastFbRow = JSON.parse(fbContent.trim().split('\n').pop()!);
    expect(lastFbRow.status).toBe('processing');
  });

  it('/capabilities surfaces the processing routes (Agent Awareness wiring)', async () => {
    const res = await request(app).get('/capabilities').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('/feedback-factory/stats');
  });
});

// ── B. WIRING INTEGRITY: the job is constructed + scheduled, not dead code ──

describe('feedback-factory-process job — wiring integrity (spec §191)', () => {
  let workspace: string;
  let agentStateDir: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-proc-wiring-'));
    agentStateDir = path.join(workspace, '.instar');
    fs.mkdirSync(agentStateDir, { recursive: true });
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'tests/e2e/feedback-factory-process-lifecycle.test.ts' });
  });

  it('the SHIPPED template installs into .instar/jobs/instar/ with a valid scheduled manifest', () => {
    // Install against the REAL repo templates (the shipped feedback-factory-process.md).
    const report = installBuiltinJobs({ agentStateDir, packageRoot: REPO_ROOT, port: 4042 });
    expect(report.errors).toEqual([]);
    expect(report.installed).toContain('feedback-factory-process');

    // The body + the per-slug schedule manifest both landed.
    expect(fs.existsSync(path.join(agentStateDir, 'jobs', 'instar', 'feedback-factory-process.md'))).toBe(true);
    const manifestPath = path.join(agentStateDir, 'jobs', 'schedule', 'feedback-factory-process.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // It validates against the loader's contract and carries a real cron schedule.
    expect(() => validateManifest(manifest, 'feedback-factory-process')).not.toThrow();
    expect(manifest.schedule).toBe('*/30 * * * *');
    expect(manifest.origin).toBe('instar');
    expect(manifest.execute.type).toBe('agentmd');
  });

  it('the loader constructs a scheduled JobDefinition from it (NOT dead code)', () => {
    const scheduleDir = path.join(agentStateDir, 'jobs', 'schedule');
    const jobsRootDir = path.join(agentStateDir, 'jobs');
    const { jobs } = loadAgentMdJobs(scheduleDir, jobsRootDir);
    const job = jobs.find((j) => j.slug === 'feedback-factory-process');
    expect(job, 'feedback-factory-process must load as a real JobDefinition').toBeTruthy();
    expect(job!.schedule).toBe('*/30 * * * *');
    // Operated-drain spec: cadence is live on development agents. The route
    // remains fleet-dark and the job distinguishes expected fleet 503 from a
    // misclassified development install.
    expect(job!.enabled).toBe(true);
  });
});
