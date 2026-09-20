// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /codex/usage — the
 * codex `/status`-equivalent rate-limit surface.
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for a feature
 * with API routes — is it actually alive on the production init path (returns
 * 200, not 404/503)? This boots the REAL AgentServer (the same path server.ts
 * uses) and verifies:
 *   1. GET /codex/usage returns 200 and the structured snapshot when a codex
 *      rollout with rate-limit data exists on disk.
 *   2. With no codex data it still returns 200 + available:false (it's a disk
 *      reader, never a 503 wired-or-not subsystem).
 *   3. The route requires Bearer auth.
 *   4. The route is read-only (POST not registered → 404).
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
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Codex usage E2E lifecycle (feature is alive)', () => {
  // Controllable fake for the live app-server reader (see server construction).
  let liveAnswer: import('../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js').CodexUsageSnapshot | null = null;
  const liveCalls: Array<string | null> = [];
  let tmpDir: string;
  let stateDir: string;
  let codexHome: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-codex-usage';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // A real codex rollout fixture under a fake $CODEX_HOME.
    codexHome = path.join(tmpDir, 'codex');
    const dir = path.join(codexHome, 'sessions', '2026', '05', '30');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'rollout-2026-05-30T12-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
      JSON.stringify({ timestamp: '2026-05-30T19:20:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } }) +
        '\n' +
        JSON.stringify({
          timestamp: '2026-05-30T19:22:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              limit_id: 'codex',
              primary: { used_percent: 13, window_minutes: 300, resets_at: 1780171524 },
              secondary: { used_percent: 93, window_minutes: 10080, resets_at: 1780174809 },
              plan_type: 'plus',
              rate_limit_reached_type: null,
            },
          },
        }) +
        '\n',
    );

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      // The PRODUCTION composition wires the real zero-spend live reader
      // (buildCodexLiveUsageReader). The suite injects a controllable fake
      // through the SAME option seam so the live-first plumbing is exercised
      // end-to-end without ever spawning a real `codex` subprocess.
      codexLiveUsageReader: async (opts) => {
        liveCalls.push(opts?.codexHome ?? null);
        return liveAnswer;
      },
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/codex-usage-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /codex/usage is alive (200) and surfaces the rate-limit snapshot', async () => {
    const res = await request(app).get('/codex/usage').query({ codexHome }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.usage.secondary.usedPercent).toBe(93);
    expect(res.body.usage.secondary.remainingPercent).toBe(7);
    expect(res.body.usage.primary.usedPercent).toBe(13);
    expect(res.body.usage.model).toBe('gpt-5.5');
    expect(res.body.usage.source).toBe('codex-rollout');
  });

  it('live-first: a live app-server answer wins over the rollout tail, through the production wiring', async () => {
    liveAnswer = {
      source: 'codex-app-server', rolloutPath: '', threadId: null,
      capturedAt: '2026-09-20T18:00:00.000Z', model: null, planType: 'pro', rateLimitReachedType: 'rate_limit_reached',
      primary: { usedPercent: 100, remainingPercent: 0, windowMinutes: 10080, resetsAt: 1790000000, resetsAtIso: '2026-09-21T22:13:20.000Z', resetsInSeconds: 1 },
      secondary: null,
    };
    try {
      const res = await request(app).get('/codex/usage').query({ codexHome }).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.usage.source).toBe('codex-app-server');
      expect(res.body.usage.primary.usedPercent).toBe(100);
      // Wiring integrity: the injected reader was consulted with the query's home.
      expect(liveCalls[liveCalls.length - 1]).toBe(codexHome);
    } finally {
      liveAnswer = null;
    }
  });

  it('returns 200 + available:false when there is no codex data', async () => {
    const emptyHome = path.join(tmpDir, 'empty-codex');
    fs.mkdirSync(emptyHome, { recursive: true });
    const res = await request(app).get('/codex/usage').query({ codexHome: emptyHome }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.usage).toBeNull();
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/codex/usage');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    expect((await request(app).post('/codex/usage').set(auth())).status).toBe(404);
  });
});
