/**
 * E2E: Self-heal — cascade dampener + lifeline drift promoter are alive on boot.
 *
 * The "feature is alive" E2E test required by the Testing Integrity Standard.
 * Verifies BOTH features are constructed, defaults applied, and functional in
 * the production initialization path.
 *
 * Coverage:
 *   1. PostUpdateMigrator applies the new defaults (updates.restartCascadeDampenerWindowMs
 *      and lifeline.driftPromoter) to a pre-existing config.json.
 *   2. AutoUpdater constructed without explicit config still has the dampener active
 *      (default 15min window).
 *   3. LifelineDriftPromoter accepts config from .instar/config.json.lifeline.driftPromoter
 *      and respects the enabled toggle.
 *   4. Server route /internal/telegram-forward sets the X-Instar-Lifeline-Patch-Drift
 *      response header when the handshake sees patch drift > 10. (This is the wire
 *      the lifeline reads in production — without it, the promoter never engages.)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { LifelineDriftPromoter } from '../../src/lifeline/LifelineDriftPromoter.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-auth-e2e-deadbeef';

describe('E2E: Self-Heal (cascade dampener + drift promoter)', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-self-heal-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  });

  afterEach(() => {
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'self-heal-cascade-and-drift.test.ts:cleanup' });
  });

  it('PostUpdateMigrator injects updates.restartCascadeDampenerWindowMs and lifeline.driftPromoter into an existing config', async () => {
    // Simulate an EXISTING agent: config without our new fields.
    const configPath = path.join(stateDir, 'config.json');
    const existingConfig = {
      projectName: 'old-agent',
      authToken: AUTH_TOKEN,
      port: 4042,
      // No `updates` or `lifeline` blocks — what an agent upgraded across versions
      // before these features existed would look like.
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

    const migrator = new PostUpdateMigrator({
      projectDir,
      stateDir,
      port: 4042,
      hasTelegram: false,
      projectName: 'old-agent',
    });
    const result = await migrator.migrate();

    // The migration should have run and patched the config.
    const upgraded = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

    expect(upgraded.updates).toMatchObject({
      restartCascadeDampenerWindowMs: 15 * 60_000,
    });
    expect(upgraded.lifeline).toMatchObject({
      driftPromoter: {
        enabled: true,
        threshold: 20,
        pollIntervalMs: 30_000,
        maxDeferMs: 60 * 60_000,
      },
    });

    // And the migration result should mention the patched top-level keys.
    const changes = result.upgraded.join('\n');
    expect(changes).toMatch(/config\.json: updates/);
    expect(changes).toMatch(/config\.json: lifeline/);
  });

  it('PostUpdateMigrator is idempotent: a second run does not overwrite user-customized values', async () => {
    const configPath = path.join(stateDir, 'config.json');
    const existingConfig = {
      projectName: 'agent',
      authToken: AUTH_TOKEN,
      port: 4042,
      updates: { restartCascadeDampenerWindowMs: 300_000 }, // user already set 5min
      lifeline: { driftPromoter: { enabled: false } },        // user opted out
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

    const migrator = new PostUpdateMigrator({
      projectDir,
      stateDir,
      port: 4042,
      hasTelegram: false,
      projectName: 'agent',
    });
    await migrator.migrate();

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect((after.updates as { restartCascadeDampenerWindowMs: number }).restartCascadeDampenerWindowMs).toBe(300_000);
    expect((after.lifeline as { driftPromoter: { enabled: boolean } }).driftPromoter.enabled).toBe(false);
    // But the missing sub-keys should be added.
    expect((after.lifeline as { driftPromoter: { threshold: number } }).driftPromoter.threshold).toBe(20);
  });

  it('AutoUpdater constructed without explicit window has the default 15min dampener active', () => {
    const checker: UpdateChecker = {
      getInstalledVersion: () => '1.2.36',
      check: async () => ({ currentVersion: '1.2.36', latestVersion: '1.2.36', updateAvailable: false, checkedAt: new Date().toISOString() }),
      getLastCheck: () => null,
    } as unknown as UpdateChecker;
    const state = { get: () => 0, set: () => {} } as unknown as StateManager;

    const updater = new AutoUpdater(checker, state, stateDir);
    // Reach into the dampener via the test helper — wiring integrity assertion.
    const bs = (updater as unknown as { _getBatchedRestartState: () => { timerActive: boolean } })._getBatchedRestartState();
    expect(bs.timerActive).toBe(false); // no batch in progress on fresh boot
    expect((updater as unknown as { dampener: { windowMs: number } }).dampener.windowMs).toBe(15 * 60_000);
  });

  it('LifelineDriftPromoter respects the enabled toggle from config-shaped input', () => {
    const restartSpy: string[] = [];
    const promoter = new LifelineDriftPromoter(
      {
        isCleanWindow: () => true,
        requestSelfRestart: async (r) => { restartSpy.push(r); },
        recordPendingNotice: () => {},
      },
      { enabled: false, threshold: 20, pollIntervalMs: 30_000, maxDeferMs: 60_000 },
    );
    promoter.noteDrift(50);
    expect(promoter._getState().kind).toBe('disabled');
    expect(restartSpy).toEqual([]);
  });

  it('end-to-end: forward against the real /internal/telegram-forward route sets the patch-drift header', async () => {
    // Freeze server version so handshake decisions are deterministic.
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.2.36', null);

    const ctx = {
      config: {
        projectName: 'e2e',
        projectDir,
        stateDir,
        port: 0,
        authToken: AUTH_TOKEN,
        sessions: {} as never,
        scheduler: {} as never,
      },
      sessionManager: { listRunningSessions: () => [] },
      state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
      scheduler: null,
      telegram: {
        onTopicMessage: () => {},
        logInboundMessage: () => {},
      },
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

    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));

    // Lifeline 25 patches behind → header set to 25.
    const res = await request(app)
      .post('/internal/telegram-forward')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        topicId: 11838,
        text: 'e2e',
        fromUserId: 1,
        messageId: 1,
        timestamp: new Date().toISOString(),
        lifelineVersion: '1.2.11',
      });

    expect(res.status).toBe(200);
    expect(res.headers['x-instar-lifeline-patch-drift']).toBe('25');
  });
});
