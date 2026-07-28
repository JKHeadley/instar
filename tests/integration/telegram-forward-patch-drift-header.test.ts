/**
 * Integration test for the X-Instar-Lifeline-Patch-Drift response header on
 * the real /internal/telegram-forward route.
 *
 * Boots Express + createRoutes() with a controlled ProcessIntegrity-frozen
 * server version, then POSTs forwards with various lifelineVersion values:
 *   - Same version → 200, no drift header
 *   - 5-patch behind → 200, no drift header (under PATCH_INFO_THRESHOLD=10)
 *   - 25-patch behind → 200, X-Instar-Lifeline-Patch-Drift: 25
 *   - MAJOR/MINOR mismatch → 426 (header path skipped)
 *
 * This is the critical integration assertion for LifelineDriftPromoter — the
 * server has to actually surface the diff for the lifeline to act on it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-auth-token-deadbeef';

function createMinimalContext(stateDir: string): RouteContext {
  return {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {} as never,
      scheduler: {} as never,
    } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: {
      getJobState: () => null,
      getSession: () => null,
      queryEvents: () => [],
    } as never,
    scheduler: null,
    telegram: {
      // forwardToServer requires onTopicMessage; mock as a noop accepter.
      onTopicMessage: () => {},
      logInboundMessage: () => {},
    } as never,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    discoveryEvaluator: null,
    startTime: new Date(),
  } as never;
}

describe('/internal/telegram-forward X-Instar-Lifeline-Patch-Drift header', () => {
  let tmpDir: string;
  let stateDir: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-drift-header-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    // Freeze the server version so handshake decisions are deterministic.
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.2.36', null);

    const ctx = createMinimalContext(stateDir);
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
  });

  afterEach(() => {
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'telegram-forward-patch-drift-header.test.ts:cleanup' });
  });

  async function forward(lifelineVersion?: string): Promise<request.Response> {
    const body: Record<string, unknown> = {
      topicId: 11838,
      text: 'hello from test',
      fromUserId: 1,
      fromUsername: 'tester',
      fromFirstName: 'Tester',
      messageId: 12345,
      timestamp: new Date().toISOString(),
    };
    if (lifelineVersion !== undefined) body.lifelineVersion = lifelineVersion;
    return request(app)
      .post('/internal/telegram-forward')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('omits the drift header when lifeline matches server version exactly', async () => {
    const res = await forward('1.2.36');
    expect(res.status).toBe(200);
    expect(res.headers['x-instar-lifeline-patch-drift']).toBeUndefined();
  });

  it('omits the drift header when patch diff is at-or-below the info threshold (10)', async () => {
    // Server is 1.2.36; lifeline 5 patches behind (1.2.31) → diff=5, no header.
    const res5 = await forward('1.2.31');
    expect(res5.status).toBe(200);
    expect(res5.headers['x-instar-lifeline-patch-drift']).toBeUndefined();

    // Edge: exactly at the threshold (diff=10).
    const res10 = await forward('1.2.26');
    expect(res10.status).toBe(200);
    expect(res10.headers['x-instar-lifeline-patch-drift']).toBeUndefined();
  });

  it('sets the drift header to the observed PATCH diff when above threshold', async () => {
    // Server 1.2.36; lifeline 1.2.11 → diff=25.
    const res = await forward('1.2.11');
    expect(res.status).toBe(200);
    expect(res.headers['x-instar-lifeline-patch-drift']).toBe('25');
  });

  it('does NOT set the drift header on a 426 upgrade-required response', async () => {
    // MINOR mismatch — handshake returns 426 BEFORE the patch-info branch.
    const res = await forward('1.1.0');
    expect(res.status).toBe(426);
    expect(res.headers['x-instar-lifeline-patch-drift']).toBeUndefined();
  });
});
