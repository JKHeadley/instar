/**
 * GET /processes/mcp-reaper through the real createRoutes pipeline.
 *  - 503 when the reaper is not wired.
 *  - 200 with the snapshot (per-proc verdicts + reapEligible count) when present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import {
  McpProcessReaper,
  type McpProcessReaperDeps,
  type McpProcessInfo,
} from '../../src/monitoring/McpProcessReaper.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function ctxWith(stateDir: string, reaper: McpProcessReaper | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
    tokenLedger: null,
    mcpProcessReaper: reaper,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function reaperDeps(procs: McpProcessInfo[]): McpProcessReaperDeps {
  return {
    listMcpProcesses: () => procs,
    getProcessTree: () => new Map(procs.map((p) => [p.pid, p.ppid])),
    getTmuxPaneMap: () => new Map(), // no tmux ancestor ⇒ orphaned
    getLiveSessions: () => new Set(),
    getInstarSessions: () => new Set(),
    killProcess: () => {},
    now: () => 1_000_000_000_000,
  };
}

describe('GET /processes/mcp-reaper (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reaper-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/mcp-process-reaper-routes.test.ts' });
  });

  function appWith(reaper: McpProcessReaper | null): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(stateDir, reaper)));
    return app;
  }

  it('returns 503 when the reaper is not wired', async () => {
    const res = await request(appWith(null)).get('/processes/mcp-reaper');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
  });

  it('returns 200 with a snapshot when the reaper is present', async () => {
    const reaper = new McpProcessReaper(
      reaperDeps([
        { pid: 100, ppid: 1, elapsedMs: 5 * 3600 * 1000, command: 'node playwright-mcp', signatureId: 'playwright-mcp' },
      ]),
      { enabled: true, dryRun: true },
    );
    const res = await request(appWith(reaper)).get('/processes/mcp-reaper');
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(Array.isArray(res.body.processes)).toBe(true);
    expect(res.body.processes[0].pid).toBe(100);
    expect(res.body.processes[0].verdict).toBe('reap-eligible'); // old + orphaned
    expect(res.body.reapEligible).toBe(1);
  });
});
