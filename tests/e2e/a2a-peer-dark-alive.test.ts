// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for a2a-single-agent-identity §3
 * (honest sender-side reporting of a send that stays queued).
 *
 * Boots the REAL AgentServer on the production init path (no tracker
 * injected) and proves:
 *   - GET /threadline/peers/health answers 200 with the §3 fields on every row
 *     (`dark`, `darkSince`, `queuedCount`, `connectedNow`) and `darkCount`;
 *   - the per-peer route carries them too, with honest nulls (no relay client
 *     here → `connectedNow: null`, never a guessed boolean);
 *   - a row seeded through the real on-disk tracker reads `dark` on the route,
 *     with the threshold read from `threadline.peerDarkNotice`;
 *   - wiring integrity for the server-side construction rule: the sentinel is
 *     armed under the `peerDarkNotice` gate ALONE (resolved through the dev
 *     gate from the real defaults), escalate-only (no redeliver);
 *   - migration E2E: an existing agent config gains the nested defaults with
 *     `enabled` omitted, twice (idempotent), and the CLAUDE.md section lands once.
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
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';
import { A2ARedeliverySentinel } from '../../src/monitoring/A2ARedeliverySentinel.js';
import { resolvePeerDarkNoticeConfig } from '../../src/threadline/peerDark.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('§3 dark peer — E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-peer-dark';
  const FP = '8c7928aa9f04fbda947172a2f9b2d81a';
  const H = 3_600_000;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-peer-dark-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
      threadline: { peerDarkNotice: { dryRun: true, queuedDarkAfterMs: 2 * H, cooldownMs: 12 * H } },
    } as InstarConfig;

    // NOTE: no a2aDeliveryTracker injected — AgentServer must self-construct it.
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/a2a-peer-dark-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /threadline/peers/health is alive (200) and carries darkCount', async () => {
    const res = await request(app).get('/threadline/peers/health').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(Array.isArray(res.body.peers)).toBe(true);
    expect(res.body.darkCount).toBe(0);
  });

  it('the per-peer route carries the §3 fields with honest nulls (no relay client → connectedNow null)', async () => {
    const res = await request(app).get(`/threadline/peers/${FP}/health`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ peerFp: FP, dark: false, darkSince: null, queuedCount: 0, queuedExpiresAt: null, lastDeliveredAt: null, connectedNow: null });
  });

  it('a row queued past the threshold in the REAL on-disk ledger reads dark on the route (threshold from config)', async () => {
    const dbPath = path.join(stateDir, 'state', 'a2a-delivery.e2e.sqlite');
    expect(fs.existsSync(dbPath)).toBe(true);
    // Write through a second handle on the same production database file.
    const t = A2ADeliveryTracker.open('e2e', stateDir);
    try {
      const sentAt = new Date(Date.now() - 3 * H).toISOString();
      t.recordSent({ messageId: 'e2e-old', peerFp: FP, peerName: 'luna', transport: 'relay', sentAt });
      t.recordRelayStatus({ messageId: 'e2e-old', status: 'queued', ttlSec: 3600 }, sentAt);
      const res = await request(app).get(`/threadline/peers/${FP}/health`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ dark: true, darkSince: sentAt, queuedCount: 1, connectedNow: null });
      const all = await request(app).get('/threadline/peers/health').set(auth());
      expect(all.body.darkCount).toBe(1);
      expect(all.body.peers.find((p: { peerFp: string }) => p.peerFp === FP)).toMatchObject({ dark: true, connectedNow: null });
    } finally {
      t.close();
    }
  });

  it('wiring integrity: the server-side construction rule arms the sentinel under the peerDarkNotice gate ALONE, escalate-only', async () => {
    // The exact rule server.ts applies: (a2aRedelivery.enabled || peerDark.enabled) && tracker.
    const devCfg: Record<string, unknown> = { developmentAgent: true };
    applyDefaults(devCfg, getMigrationDefaults('standalone'));
    const peerDark = resolvePeerDarkNoticeConfig(devCfg as never);
    expect(peerDark).toMatchObject({ enabled: true, dryRun: true, queuedDarkAfterMs: 2 * H, cooldownMs: 12 * H });
    const legacyEnabled = (devCfg as { monitoring?: { a2aRedelivery?: { enabled?: boolean } } }).monitoring?.a2aRedelivery?.enabled === true;
    expect(legacyEnabled).toBe(false);
    expect(legacyEnabled || peerDark.enabled).toBe(true);
    const tracker = A2ADeliveryTracker.openMemory();
    try {
      const s = new A2ARedeliverySentinel(
        { tracker, agentId: 'e2e', log: { log: () => {}, warn: () => {} } },
        { enabled: legacyEnabled, peerDark: { ...peerDark } },
      );
      expect(s.armed).toBe(true);
      const r = await s.tick();
      expect(r.disabled).toBe(false);
      expect(r.overdue).toBe(0); // redelivery loop off → escalate-only
      s.stop();
    } finally {
      tracker.close();
    }
    // On the fleet the same rule leaves the sentinel unarmed (today's behaviour).
    const fleetCfg: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleetCfg, getMigrationDefaults('standalone'));
    expect(resolvePeerDarkNoticeConfig(fleetCfg as never).enabled).toBe(false);
  });

  it('migration E2E: an existing agent gains the nested defaults (enabled omitted) + the CLAUDE.md section, idempotently', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-peer-dark-mig-'));
    try {
      const sd = path.join(projectDir, '.instar');
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n');
      const cfg: Record<string, unknown> = { projectName: 'mig', threadline: { relayEnabled: true } };
      applyDefaults(cfg, getMigrationDefaults('standalone'));
      applyDefaults(cfg, getMigrationDefaults('standalone')); // twice: idempotent
      const t = cfg.threadline as { relayEnabled: boolean; peerDarkNotice: Record<string, unknown> };
      expect(t.relayEnabled).toBe(true);
      expect(t.peerDarkNotice).toEqual({ dryRun: true, queuedDarkAfterMs: 7200000, cooldownMs: 43200000 });
      const m = new PostUpdateMigrator({ projectDir, stateDir: sd, port: 4321, hasTelegram: false, projectName: 'mig' });
      type R = { upgraded: string[]; skipped: string[]; errors: string[] };
      const r1: R = { upgraded: [], skipped: [], errors: [] };
      (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r1);
      const r2: R = { upgraded: [], skipped: [], errors: [] };
      (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r2);
      expect(r1.upgraded).toContain('CLAUDE.md: added A2A dark peers section');
      expect(r2.upgraded).not.toContain('CLAUDE.md: added A2A dark peers section');
      const md = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(md.split('### A2A dark peers').length - 1).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/a2a-peer-dark-alive.test.ts' });
    }
  });
});
