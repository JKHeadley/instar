/**
 * E2E — McpProcessReaper on the PRODUCTION path.
 *
 * Phase 1 (the most important test): GET /processes/mcp-reaper returns 200
 * (not 503) through the REAL AgentServer → RouteContext plumbing — the
 * "dead on arrival" / "wired-but-dropped (?? null)" guard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { McpProcessReaper, type McpProcessReaperDeps } from '../../src/monitoring/McpProcessReaper.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('McpProcessReaper E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-mcp-process-reaper';

  const deps: McpProcessReaperDeps = {
    listMcpProcesses: () => [
      { pid: 100, ppid: 1, elapsedMs: 5 * 3600 * 1000, command: 'node mcp-remote https://api.fathom.ai/mcp', signatureId: 'mcp-remote' },
    ],
    getProcessTree: () => new Map([[100, 1]]),
    getTmuxPaneMap: () => new Map(),
    getLiveSessions: () => new Set(),
    getInstarSessions: () => new Set(),
    killProcess: () => {},
    now: () => 1_000_000_000_000,
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reaper-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e-test', agentName: 'E2E Test' }));

    const reaper = new McpProcessReaper(deps, { enabled: true, dryRun: true });
    const config: InstarConfig = {
      projectName: 'e2e-test', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000, version: '0.10.3',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    };
    const state = new StateManager(stateDir);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state, mcpProcessReaper: reaper });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/mcp-process-reaper-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  it('GET /processes/mcp-reaper returns 200 with a snapshot through the real AgentServer plumbing', async () => {
    const res = await request(app).get('/processes/mcp-reaper').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(Array.isArray(res.body.processes)).toBe(true);
    expect(res.body.reapEligible).toBe(1); // old + orphaned mcp-remote
  });
});
