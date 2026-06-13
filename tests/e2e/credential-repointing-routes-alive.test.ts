// safe-git-allow: test file — tmpdir scratch dirs only.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" — WS5.2 Step 7 /credentials/* levers. Per TESTING-INTEGRITY-SPEC
 * the single most important test for a feature with API routes: are the routes WIRED on the
 * production init path (the REAL AgentServer factory server.ts uses), and does the flag-OFF dark
 * ship deliver a STRICT no-op (503 on every lever, byte-for-byte today's behavior)?
 *
 * Proves:
 *   (a) ENABLED (credentialRepointing wired + flag on): /credentials/swap executes the live
 *       executor (dry-run → outcome 'dry-run', zero writes); /credentials/locations reports active.
 *   (b) DARK (flag off): every POST lever 503s; /credentials/rebalancer 503; /credentials/locations
 *       answers but reports the dark mode — the strict no-op dark-ship guarantee.
 *   (c) every lever requires Bearer auth.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { CredentialLocationLedger, type IdentityOracle } from '../../src/core/CredentialLocationLedger.js';
import { CredentialSwapExecutor, type KeychainCredentialExec, type ResolveSlotIdentity } from '../../src/core/CredentialSwapExecutor.js';
import { CredentialAuditEmit } from '../../src/core/CredentialAuditEmit.js';
import { CredentialManualLevers } from '../../src/core/CredentialManualLevers.js';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';
import { claudeCredentialService } from '../../src/core/OAuthRefresher.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-cred-step7';
const SLOT_A = '/h/.claude';
const SLOT_B = '/h/.claude-2';
const ACC_A = 'acc-A';
const ACC_B = 'acc-B';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}
function baseConfig(stateDir: string, projectDir: string, enabled: boolean): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    subscriptionPool: { credentialRepointing: { enabled, dryRun: true, manualLeversEnabled: true } },
  } as InstarConfig;
}
function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

const noopOracle: IdentityOracle = { async resolveSlotTenant() { return { unavailable: true }; } };
function memKeychain(): KeychainCredentialExec {
  const map = new Map<string, string>();
  map.set(claudeCredentialService(SLOT_A), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-aaaa1111bbbb2222cccc3333', refreshToken: 'sk-ant-ort01-rrrr1111' } }));
  map.set(claudeCredentialService(SLOT_B), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-dddd4444eeee5555ffff6666', refreshToken: 'sk-ant-ort01-rrrr2222' } }));
  return { async readService(s) { return map.get(s) ?? null; }, async writeService(s, v) { map.set(s, v); }, async deleteService(s) { map.delete(s); } };
}
const resolveAllow: ResolveSlotIdentity = async (slot) => ({ accountId: slot === SLOT_A ? ACC_B : ACC_A });

function buildRepointing(stateDir: string, enabled: boolean) {
  const ledger = new CredentialLocationLedger({ stateDir, pool: { list: () => [] }, oracle: noopOracle });
  ledger.recordAssignment(SLOT_A, ACC_A, { op: 'seed' });
  ledger.recordAssignment(SLOT_B, ACC_B, { op: 'seed' });
  const audit = new CredentialAuditEmit({ writeLine: () => {} });
  const swapExecutor = new CredentialSwapExecutor({
    funnel: new CredentialWriteFunnel(), ledger, keychain: memKeychain(),
    resolveIdentity: resolveAllow, config: { enabled, dryRun: true }, reverifyDelayMs: 5,
  });
  return { ledger, swapExecutor, resolveIdentity: resolveAllow, audit, levers: new CredentialManualLevers() };
}

describe('WS5.2 Step 7 /credentials/* E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let enabledServer: AgentServer; let enabledApp: express.Express;
  let darkServer: AgentServer; let darkApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-step7-e2e-'));

    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    enabledServer = new AgentServer({
      config: baseConfig(enabledStateDir, tmpDir, true),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(enabledStateDir),
      credentialRepointing: buildRepointing(enabledStateDir, true),
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    const darkStateDir = mkStateDir(tmpDir, 'dark');
    darkServer = new AgentServer({
      config: baseConfig(darkStateDir, tmpDir, false),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(darkStateDir),
      credentialRepointing: buildRepointing(darkStateDir, false),
    });
    await darkServer.start();
    darkApp = darkServer.getApp();
  });

  afterAll(async () => {
    await enabledServer?.stop();
    await darkServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/credential-repointing-routes-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: /credentials/swap executes the live executor (200, dry-run); locations reports active', async () => {
    const r = await request(enabledApp).post('/credentials/swap').set(auth()).send({ slotA: SLOT_A, slotB: SLOT_B });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('dry-run'); // live decision loop ran, zero writes
    expect(JSON.stringify(r.body)).not.toContain('sk-ant-'); // §2.9 scrub chokepoint

    const loc = await request(enabledApp).get('/credentials/locations').set(auth());
    expect(loc.status).toBe(200);
    expect(loc.body.enabled).toBe(true);
    expect(loc.body.mode).toBe('active');
  });

  it('(b) DARK: every POST lever 503s; rebalancer 503; locations reports dark (strict no-op)', async () => {
    expect((await request(darkApp).post('/credentials/swap').set(auth()).send({ slotA: SLOT_A, slotB: SLOT_B })).status).toBe(503);
    expect((await request(darkApp).post('/credentials/set-default').set(auth()).send({ accountId: ACC_A })).status).toBe(503);
    expect((await request(darkApp).post('/credentials/restore-enrollment').set(auth()).send({})).status).toBe(503);
    expect((await request(darkApp).get('/credentials/rebalancer').set(auth())).status).toBe(503);
    const loc = await request(darkApp).get('/credentials/locations').set(auth());
    expect(loc.status).toBe(200);
    expect(loc.body.enabled).toBe(false);
  });

  it('(c) every lever requires Bearer auth', async () => {
    expect((await request(enabledApp).post('/credentials/swap').send({ slotA: SLOT_A, slotB: SLOT_B })).status).toBe(401);
    expect((await request(enabledApp).post('/credentials/set-default').send({ accountId: ACC_A })).status).toBe(401);
    expect((await request(enabledApp).post('/credentials/restore-enrollment').send({})).status).toBe(401);
    expect((await request(enabledApp).get('/credentials/locations')).status).toBe(401);
    expect((await request(enabledApp).get('/credentials/rebalancer')).status).toBe(401);
  });

  it('rebalancer is 503 in Increment A even when the feature is enabled', async () => {
    expect((await request(enabledApp).get('/credentials/rebalancer').set(auth())).status).toBe(503);
  });
});
