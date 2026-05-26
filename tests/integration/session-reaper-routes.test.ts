/**
 * GET /sessions/reaper through the real createRoutes pipeline.
 *  - 503 when the reaper is not wired.
 *  - 200 with the snapshot (pressure tier + per-session verdicts) when present.
 *  - Dry-run end-to-end: a reap-eligible session is logged-but-not-killed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SessionReaper, type SessionReaperDeps } from '../../src/monitoring/SessionReaper.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';

function ctxWith(stateDir: string, reaper: SessionReaper | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
    tokenLedger: null,
    sessionReaper: reaper,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function reaperDeps(sessions: Session[]): SessionReaperDeps {
  return {
    listRunningSessions: () => sessions,
    captureOutput: () => 'output\n? for shortcuts\n> ',
    hasActiveProcesses: () => false,
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => ({ resolved: true, path: '/t', size: 1, mtime: 1 }),
    isRecoveryActive: () => false,
    isRelayLeaseActive: () => false,
    hasPendingInjection: () => false,
    topicBinding: () => null,
    recentUserMessage: () => false,
    activeCommitmentForTopic: () => false,
    activeSubagentCount: () => 0,
    buildOrAutonomousActive: () => false,
    protectedSessions: () => [],
    pressure: () => ({ tier: 'critical' }),
    terminate: async () => ({ terminated: true }),
    markReaping: () => {},
    clearReaping: () => {},
  };
}

describe('GET /sessions/reaper (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/session-reaper-routes.test.ts' });
  });

  function appWith(reaper: SessionReaper | null): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(stateDir, reaper)));
    return app;
  }

  it('returns 503 when the reaper is not wired', async () => {
    const res = await request(appWith(null)).get('/sessions/reaper');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
  });

  it('returns 200 with a snapshot when the reaper is present', async () => {
    const session: Session = {
      id: 's1', name: 'sess', status: 'running', tmuxSession: 't1',
      startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    };
    const reaper = new SessionReaper(reaperDeps([session]), { enabled: true });
    const res = await request(appWith(reaper)).get('/sessions/reaper');
    expect(res.status).toBe(200);
    expect(res.body.pressure.tier).toBe('critical');
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions[0].name).toBe('sess');
    expect(['keep', 'reap-eligible']).toContain(res.body.sessions[0].verdict);
  });

  it('dry-run snapshot reports dryRun:true and never reaps', async () => {
    const session: Session = {
      id: 's1', name: 'sess', status: 'running', tmuxSession: 't1',
      startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    };
    let killed = 0;
    const deps = reaperDeps([session]);
    deps.terminate = async () => { killed++; return { terminated: true }; };
    const reaper = new SessionReaper(deps, {
      enabled: true, dryRun: true, minAgeMinutes: 0, confirmObservations: 1,
      confirmWindowMinutes: 0, idleThresholdCriticalMinutes: 0, finalGraceSec: 0,
    });
    // Drive a few ticks; in dry-run nothing must be killed.
    for (let i = 0; i < 4; i++) await reaper.tick();
    const res = await request(appWith(reaper)).get('/sessions/reaper');
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(killed).toBe(0);
  });
});
