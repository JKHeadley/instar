/**
 * E2E lifecycle test (Tier 3) for Human-as-Detector.
 *
 * Boots the real route tree (createRoutes) on a live HTTP server and proves
 * the feature is ALIVE end-to-end: an observed inbound human correction flows
 * through the gating helper, lands in the heat map AND on disk, and the
 * /human-as-detector/summary endpoint returns 200 (not 503) over real HTTP.
 *
 * "Is the feature actually alive?" — the single most important tier for any
 * feature with API routes (CLAUDE.md Testing Integrity Standard).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { HumanAsDetectorLog, observeInboundMessage } from '../../src/monitoring/HumanAsDetectorLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('E2E: Human-as-Detector lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-had-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    HumanAsDetectorLog.resetForTesting();
    HumanAsDetectorLog.getInstance().configure({ stateDir, agentName: 'had-e2e' });

    const ctx = {
      config: {
        projectName: 'had-e2e', projectDir, stateDir, port: 0,
        sessions: {} as any, scheduler: {} as any,
      } as any,
      sessionManager: { listRunningSessions: () => [] } as any,
      state: { getJobState: () => null, getSession: () => null } as any,
      scheduler: null, telegram: null, relationships: null, feedback: null,
      dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
      quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
      watchdog: null, triageNurse: null, topicMemory: null, discoveryEvaluator: null,
      startTime: new Date(),
    } as RouteContext;

    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    HumanAsDetectorLog.resetForTesting();
    try {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/human-as-detector-lifecycle.test.ts' });
    } catch { /* best-effort */ }
  });

  it('endpoint is alive (200) and empty before any signal', async () => {
    const res = await fetch(`${baseUrl}/human-as-detector/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byLayer).toEqual([]);
    expect(body.recent).toEqual([]);
  });

  it('an observed inbound correction flows to the live endpoint AND to disk', async () => {
    // Simulate the server's inbound-message wiring via the same gating helper.
    const signal = observeInboundMessage(HumanAsDetectorLog.getInstance(), {
      fromUser: true,
      text: "you said that's done, but the registry says it's still open",
      topicId: 12118,
      messageId: 7,
    });
    expect(signal).not.toBeNull();

    const res = await fetch(`${baseUrl}/human-as-detector/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byLayer.length).toBeGreaterThan(0);
    expect(body.recent.length).toBe(1);
    expect(body.recent[0].topicId).toBe(12118);

    // End-to-end persistence: the signal is on disk for cross-session audit.
    const jsonlPath = path.join(stateDir, 'metrics', 'human-as-detector.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const persisted = JSON.parse(lines[0]);
    expect(persisted.topicId).toBe(12118);
    expect(persisted.agentName).toBe('had-e2e');
  });
});
