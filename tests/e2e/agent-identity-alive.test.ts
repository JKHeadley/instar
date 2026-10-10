// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" (a2a-single-agent-identity §Tests): the production
 * AgentServer init path — `/agent-identity/audit` (+ `?scope=pool`),
 * `POST /agent-identity/reload` and `/threadline/health.identityCoherence` answer 200 (never
 * 503); wiring integrity (the detector, the lock, the audit and the reload lever are real);
 * the migration (config default + CLAUDE.md section) lands once and is idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HandshakeManager } from '../../src/threadline/HandshakeManager.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('agent-identity E2E lifecycle (feature is alive on the production init path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let fingerprint: string;
  const AUTH = 'test-e2e-agent-identity';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-identity-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    // A standalone machine with a canonical identity (what a real init leaves behind).
    const kp = generateIdentityKeyPair();
    fingerprint = computeFingerprint(kp.publicKey);
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({ publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'), privateKeyEncryption: 'none', createdAt: new Date().toISOString() }), { mode: 0o600 });

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    // NOTE: no `agentIdentity` deps injected (single machine) — AgentServer must self-construct
    // the runtime (detector + audit + reload lever) from this machine's own disk.
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      handshakeManager: new HandshakeManager(stateDir, 'e2e'),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/agent-identity-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /agent-identity/audit is alive (200, not 503) with the real shape', async () => {
    const res = await request(app).get('/agent-identity/audit').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('local');
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.posture).toBe('provisioned');
    expect(res.body.adoption).toBeNull(); // no loop on a provisioned machine
  });

  it('GET /agent-identity/audit?scope=pool is alive on a single machine (no peers → empty pool, never a 500)', async () => {
    const res = await request(app).get('/agent-identity/audit?scope=pool').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    expect(res.body.pool).toEqual({ peersQueried: 0, peersOk: 0, failed: [] });
  });

  it('POST /agent-identity/reload is alive: re-reads this machine\'s own disk, answers the fingerprint, writes a key-free audit row; a second call inside 60 s answers 429', async () => {
    const res = await request(app).post('/agent-identity/reload').set(auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fingerprint).toBe(fingerprint);
    expect(res.body.posture).toBe('provisioned');
    const again = await request(app).post('/agent-identity/reload').set(auth()).send({});
    expect(again.status).toBe(429);
    expect(again.headers['retry-after']).toBeDefined();
    const audit = await request(app).get('/agent-identity/audit').set(auth());
    const reloaded = (audit.body.rows as Array<{ event: string; fingerprint?: string }>).filter((r) => r.event === 'identity-reloaded');
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].fingerprint).toBe(fingerprint);
    const raw = fs.readFileSync(path.join(stateDir, 'logs', 'agent-identity.jsonl'), 'utf-8');
    const priv = JSON.parse(fs.readFileSync(path.join(stateDir, 'identity.json'), 'utf-8')).privateKey as string;
    expect(raw).not.toContain(priv);
  });

  it('GET /threadline/health carries identityCoherence on the production path (not-run until the first tick, never absent)', async () => {
    const res = await request(app).get('/threadline/health');
    expect(res.status).toBe(200);
    expect(res.body.fingerprint).toBe(fingerprint);
    expect(res.body.identityCoherence).toBeDefined();
    expect(['not-run', 'agree', 'partial-agree', 'disagree', 'cannot-tell']).toContain(res.body.identityCoherence.state);
    expect(res.body.identityCoherence).toHaveProperty('connectedAs');
    expect(res.body.identityCoherence).toHaveProperty('siblingsPublish');
    expect(res.body.identityCoherence).toHaveProperty('cannotTellRounds');
    expect(res.body.identityCoherence).toHaveProperty('lastCheckedAt');
    expect(res.body.relay.state).not.toBe('not-provisioned'); // a provisioned machine
  });

  it('wiring integrity: the runtime is a real implementation — a detector round on a single machine reads cannot-tell from this disk, not a stub', async () => {
    const ctx = (server as unknown as { routeContext: { agentIdentity?: { coherence: { runOnce(): Promise<unknown>; health(): { state: string; selfDisk: string | null } } } } }).routeContext;
    expect(ctx.agentIdentity).toBeTruthy();
    await ctx.agentIdentity!.coherence.runOnce();
    const h = ctx.agentIdentity!.coherence.health();
    expect(h.selfDisk).toBe(fingerprint);
    expect(h.state).toBe('cannot-tell'); // one value observed (self), no siblings — never `agree`
    const health = await request(app).get('/threadline/health');
    expect(health.body.identityCoherence.state).toBe('cannot-tell');
    expect(health.body.identityCoherence.lastCheckedAt).not.toBeNull();
  });
});

describe('agent-identity migration parity (lands once, idempotent)', () => {
  it('migrateConfig adds agentIdentity.adoption {enabled:true} once and never overwrites an explicit value; migrateClaudeMd adds the section once', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-identity-mig-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4042, projectName: 'mig' }));
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n\n## Threadline Network (Agent-to-Agent Communication)\n');
    const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'mig' });
    type R = { upgraded: string[]; skipped: string[]; errors: string[] };
    const run = (fn: 'migrateConfig' | 'migrateClaudeMd'): R => {
      const r: R = { upgraded: [], skipped: [], errors: [] };
      (migrator as unknown as Record<string, (r: R) => void>)[fn](r);
      return r;
    };
    const c1 = run('migrateConfig');
    expect(c1.upgraded).toContain('config.json: added agentIdentity.adoption default (enabled: true)');
    const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8')) as { agentIdentity?: { adoption?: { enabled?: boolean } } };
    expect(cfg.agentIdentity?.adoption).toEqual({ enabled: true });
    const c2 = run('migrateConfig');
    expect(c2.upgraded.filter((u) => u.includes('agentIdentity'))).toEqual([]); // idempotent
    // An operator's explicit false is never overwritten.
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4042, projectName: 'mig', agentIdentity: { adoption: { enabled: false } } }));
    run('migrateConfig');
    expect((JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8')) as typeof cfg).agentIdentity?.adoption?.enabled).toBe(false);

    const m1 = run('migrateClaudeMd');
    expect(m1.upgraded).toContain('CLAUDE.md: added One identity across my machines (agent identity) section');
    const md = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(md).toContain('### One identity across my machines (agent identity)');
    expect(md).toContain('instar identity adopt --from <sibling>');
    expect(md).toContain('identityCoherence.state');
    run('migrateClaudeMd');
    const md2 = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(md2.split('### One identity across my machines (agent identity)').length).toBe(2); // exactly once
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/agent-identity-alive.test.ts' });
  });
});
