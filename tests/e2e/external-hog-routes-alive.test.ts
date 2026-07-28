// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" (TESTING-INTEGRITY-SPEC — the single most important test for a
 * feature with API routes): are the External-Hog routes WIRED on the real AgentServer, does a
 * REAL ExternalHogSentinel tick harmlessly and report an honest status, and does the dark ship
 * deliver a strict 503 no-op? (CMT-1901.)
 *
 * Proves:
 *   (a) ENABLED (a real sentinel wired): GET /external-hog → 200 with a live status + arm block;
 *       a harmless tick over a benign process table advances the sampler; the PIN-gated arm→disarm
 *       →re-arm epoch lifecycle runs end-to-end through the routes + the durable marker.
 *   (b) DARK (sentinel unwired): GET /external-hog → 503 (strict no-op).
 *   (c) Bearer auth is required; arm requires the PIN (not just the Bearer token).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createExternalHogServerPrimitives } from '../../src/monitoring/ExternalHogServerPrimitives.js';
import { createExternalHogAdapters } from '../../src/monitoring/ExternalHogRealAdapters.js';
import { ExternalHogSentinel } from '../../src/monitoring/ExternalHogSentinel.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-external-hog';
const PIN = '531642';
// A benign 1-row ps table → a plausible parse (heartbeat advances) but no candidate.
const BENIGN_PS = '1 0 501 Wed Jul 2 09:00:00 2026 10:00.00 node';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}
function baseConfig(stateDir: string, projectDir: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}
function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

function buildSentinel(stateDir: string): ExternalHogSentinel {
  const prims = createExternalHogServerPrimitives({
    exec: async () => BENIGN_PS, // every ps read → the benign table; no candidate ever
    signal: () => false,
    evaluate: async () => '{"action":"leave"}',
    raiseAttention: () => undefined,
    config: () => ({ enabled: true, dryRun: true }),
    stateDir, ownEuid: 501, serverPid: process.pid,
    sleep: async () => {},
  });
  const adapters = createExternalHogAdapters(prims, {
    cpuCoreThreshold: 1.5, maxAncestorHops: 30, killTimeCpuRecheckWindowMs: 2500, killTimeCpuCoreThreshold: 0.5,
  });
  return new ExternalHogSentinel(adapters, {
    sampler: { ownEuid: 501, cpuCoreThreshold: 1.5, sampleWindowMs: 30000, maxAncestorHops: 30 },
    sustainedSampleCount: 3, maxClassificationsPerScan: 4,
    breaker: { windowMs: 3_600_000, maxPerWindow: 3, keyIsVolatile: false },
    killFunnel: { sigtermGraceMs: 12000, maxKillDeferrals: 3 },
    noticeBudgetPerWindow: 4, killLedgerRetentionMs: 3_600_000, samplerDeadThresholdMs: 300000,
  });
}

describe('External-Hog routes E2E (feature is alive)', () => {
  let tmpDir: string;
  let enabledServer: AgentServer; let enabledApp: express.Express;
  let darkServer: AgentServer; let darkApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exthog-e2e-'));
    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    const sentinel = buildSentinel(enabledStateDir);
    await sentinel.tick(); // one harmless tick (benign table → heartbeat advances, no candidate)
    enabledServer = new AgentServer({
      config: baseConfig(enabledStateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(enabledStateDir),
      externalHogSentinel: sentinel,
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    const darkStateDir = mkStateDir(tmpDir, 'dark');
    darkServer = new AgentServer({
      config: baseConfig(darkStateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(darkStateDir),
      // externalHogSentinel omitted → dark
    });
    await darkServer.start();
    darkApp = darkServer.getApp();
  });

  afterAll(async () => {
    await enabledServer?.stop();
    await darkServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/external-hog-routes-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: GET /external-hog → 200 with a live status + arm block; the tick advanced the sampler', async () => {
    const r = await request(enabledApp).get('/external-hog').set(auth());
    expect(r.status).toBe(200);
    expect(typeof r.body.status.effectiveState).toBe('string');
    expect(r.body.status.samplerDead).toBe(false); // the benign tick parsed → not blind
    expect(r.body.status.effectiveState).toBe('on-dry-run'); // enabled + dryRun + not blind
    expect(r.body.arm).toMatchObject({ armed: false, lastDisarmEpoch: 0 });
  });

  it('(a) ENABLED: the PIN-gated arm → disarm → re-arm epoch lifecycle runs end-to-end', async () => {
    await request(enabledApp).post('/external-hog/arm').set(auth()).send({ pin: PIN }).expect(200);
    let get = await request(enabledApp).get('/external-hog').set(auth());
    expect(get.body.arm).toMatchObject({ armed: true, armEpoch: 1 });
    expect(get.body.arm.armedClasses).toContain('vscode-exthost');

    await request(enabledApp).post('/external-hog/disarm').set(auth()).send({}).expect(200);
    get = await request(enabledApp).get('/external-hog').set(auth());
    expect(get.body.arm.armed).toBe(false);

    const rearm = await request(enabledApp).post('/external-hog/arm').set(auth()).send({ pin: PIN });
    expect(rearm.body.armEpoch).toBe(2); // strictly higher — a disarm can't be silently un-done
  });

  it('(b) DARK: GET /external-hog → 503 (strict no-op)', async () => {
    expect((await request(darkApp).get('/external-hog').set(auth())).status).toBe(503);
  });

  it('(c) Bearer auth is required; arm requires the PIN, not just the Bearer token', async () => {
    expect((await request(enabledApp).get('/external-hog')).status).toBe(401); // no Bearer
    // Bearer present but NO PIN → 403 (a real kill can't be armed by an agent/Bearer token).
    expect((await request(enabledApp).post('/external-hog/arm').set(auth()).send({})).status).toBe(403);
  });
});
