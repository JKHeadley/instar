// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration + E2E "feature is alive" coverage for the Gemini capacity
 * escalation monitor's observability route, booting the REAL AgentServer (the
 * same path server.ts uses). Verifies both sides of the enabled boundary:
 *   - disabled (default) → GET /gemini/capacity 503;
 *   - enabled → 200 with the live gate status shape;
 *   - Bearer auth required.
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

function mockSessions() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function baseConfig(stateDir: string, tmpDir: string, auth: string, enabled: boolean): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: { geminiCapacityEscalation: { enabled, escalateAfterMinutes: 60 } },
    updates: {},
  } as InstarConfig;
}

async function boot(enabled: boolean, auth: string): Promise<{ server: AgentServer; app: express.Express; tmpDir: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cap-esc-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const server = new AgentServer({ config: baseConfig(stateDir, tmpDir, auth, enabled), sessionManager: mockSessions() as any, state: new StateManager(stateDir) });
  await server.start();
  return { server, app: server.getApp(), tmpDir };
}

describe('GET /gemini/capacity (Gemini capacity escalation route)', () => {
  const AUTH = 'test-gemini-cap';
  let enabled: Awaited<ReturnType<typeof boot>>;
  let disabled: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    enabled = await boot(true, AUTH);
    disabled = await boot(false, AUTH);
  });

  afterAll(async () => {
    await enabled.server.stop();
    await disabled.server.stop();
    SafeFsExecutor.safeRmSync(enabled.tmpDir, { recursive: true, force: true, operation: 'tests/integration/gemini-capacity-escalation-route.test.ts' });
    SafeFsExecutor.safeRmSync(disabled.tmpDir, { recursive: true, force: true, operation: 'tests/integration/gemini-capacity-escalation-route.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('is alive (200, not 503) through AgentServer when enabled, with the gate status shape', async () => {
    const res = await request(enabled.app).get('/gemini/capacity').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(typeof res.body.blocked).toBe('boolean');
    expect(typeof res.body.remainingMs).toBe('number');
  });

  it('503s when the monitor is disabled (default)', async () => {
    const res = await request(disabled.app).get('/gemini/capacity').set(auth());
    expect(res.status).toBe(503);
  });

  it('requires Bearer auth', async () => {
    const res = await request(enabled.app).get('/gemini/capacity');
    expect(res.status).toBe(401);
  });
});
