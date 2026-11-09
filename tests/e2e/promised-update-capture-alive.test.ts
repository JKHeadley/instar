// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" for promised-update capture
 * (docs/specs/promised-update-capture.md).
 *
 * Mirrors the production wiring in src/commands/server.ts: a real
 * CommitmentTracker injected into a real AgentServer, and the capture chained
 * onto the adapter's onMessageLogged with the SAME helper and gate resolver the
 * server uses. An agent message promising a time must surface as a dated
 * promise on the real check-in reminder route, and the real pass must pick it
 * up once the time has passed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  PromisedUpdateCapture,
  chainPromisedUpdateCapture,
  resolvePromisedUpdateCaptureEnabled,
  type LoggedMessage,
} from '../../src/monitoring/PromisedUpdateCapture.js';

describe('Promised-update capture E2E (feature is alive)', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;
  let tracker: CommitmentTracker;
  const adapter: { onMessageLogged: ((e: LoggedMessage) => void) | null } = { onMessageLogged: null };
  const AUTH = 'test-e2e-promised-update';
  // The promise was made two hours ago, "in 30 minutes" — so it is due now.
  const madeAt = Date.now() - 2 * 3_600_000;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promised-update-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    tracker = new CommitmentTracker({ stateDir, liveConfig: () => config as any } as any);
    tracker.start();

    // MIRROR server.ts: the one-statement wiring, same helper, same gate.
    const wired = chainPromisedUpdateCapture(adapter, new PromisedUpdateCapture({
      tracker,
      enabled: () => resolvePromisedUpdateCaptureEnabled((config as any).commitments, config),
      now: () => madeAt,
      log: () => {},
    }));
    expect(wired).toBe(true);

    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null } as any,
      state: new StateManager(stateDir),
      commitmentTracker: tracker,
    } as any);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    tracker?.stop();
    await server?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/promised-update-capture-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('an agent message promising a time becomes a dated promise on the live route', async () => {
    adapter.onMessageLogged!({
      messageId: 501, topicId: 4242, fromUser: false, provenance: 'agent',
      timestamp: new Date(madeAt).toISOString(),
      text: "Tests are running. I'll report back in 30 minutes.",
    });
    const view = await request(app).get('/commitments/check-in-reminder').set(auth());
    expect(view.status).toBe(200);
    expect(view.body.enabled).toBe(true);
    expect(view.body.datedCount).toBeGreaterThanOrEqual(1);
    const captured = tracker.getActive().find((c) => c.externalKey === 'promised-update:4242:501');
    expect(captured).toBeTruthy();
    expect(captured!.checkInAt).toBeTruthy();
  });

  it('the real pass picks it up once due (dry-run default: would send, sends nothing)', async () => {
    const id = tracker.getActive().find((c) => c.externalKey === 'promised-update:4242:501')!.id;
    const res = await request(app).post('/commitments/check-in-reminder/pass').set(auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
    expect(res.body.dueIds).toContain(id);
    expect(res.body.wouldSend).toBeGreaterThanOrEqual(1);
    expect(res.body.sent).toBe(0);
  });
});
