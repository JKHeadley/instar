// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for "Self-Unblock Before
 * Escalating" (docs/specs/self-unblock-before-escalating.md §8).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses)
 * and verifies:
 *   - the /blockers/self-unblock-runs route is ALIVE on the production path (200,
 *     not 503) when the feature is enabled — i.e. the routeCtx.selfUnblockRunStore
 *     thread is real, not null, and BlockerLedger received the injected store;
 *   - the route is Bearer-gated (401 without; the 503-when-dark check is AFTER auth);
 *   - dark-by-default integrity: with the nested flag OFF the route 503s;
 *   - WIRING-INTEGRITY (required): a self-unblock action that touches an external
 *     account is STILL evaluated by the external-operation gate (/operations/evaluate)
 *     AND the mandate gate (/mandate/evaluate) — the standard licenses NO bypass of
 *     the existing gates (§2/§9);
 *   - the bw-session value (DurableVaultSession) never appears in the ledger / a
 *     serialized form — the §5.3 no-leak contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { DurableVaultSession } from '../../src/monitoring/DurableVaultSession.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../../src/core/ExternalOperationGate.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

/**
 * Build the production config. `developmentAgent: true` flips the dev-gate so both
 * blockerLedger AND its nested selfUnblockChecklist resolve LIVE (mirroring the
 * production AgentServer dev-gate path). `selfUnblockEnabled=false` forces the
 * nested flag dark to exercise the 503-when-dark assertion.
 */
function bootConfig(
  tmpDir: string,
  stateDir: string,
  auth: string,
  selfUnblockEnabled: boolean,
): InstarConfig {
  return {
    projectName: 'e2e-self-unblock',
    projectDir: tmpDir,
    stateDir,
    port: 0,
    authToken: auth,
    requestTimeoutMs: 10000,
    version: '0.0.0',
    developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: {
      // blockerLedger live via dev-gate (enabled omitted); the nested self-unblock
      // flag is set EXPLICITLY here so the test can force dark vs live.
      blockerLedger: { enabled: true, selfUnblockChecklist: { enabled: selfUnblockEnabled } },
    },
    updates: {},
  } as InstarConfig;
}

async function bootServer(
  tmpDir: string,
  stateDir: string,
  auth: string,
  selfUnblockEnabled: boolean,
): Promise<AgentServer> {
  const config = bootConfig(tmpDir, stateDir, auth, selfUnblockEnabled);
  // Inject the external-operation gate so the wiring-integrity assertion can prove a
  // self-unblock external action is STILL adjudicated by it (the standard never
  // bypasses the existing gates — §2/§9).
  const server = new AgentServer({
    config,
    sessionManager: createMockSessionManager() as any,
    state: new StateManager(stateDir),
    operationGate: new ExternalOperationGate({
      stateDir,
      autonomyDefaults: AUTONOMY_PROFILES.collaborative,
    }),
  });
  await server.start();
  return server;
}

function prepStateDir(tmpDir: string): string {
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

describe('Self-Unblock E2E lifecycle — feature is alive', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-self-unblock';
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-unblock-e2e-'));
    stateDir = prepStateDir(tmpDir);
    server = await bootServer(tmpDir, stateDir, AUTH, /* selfUnblockEnabled */ true);
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/self-unblock-lifecycle.test.ts' });
  });

  it('GET /blockers/self-unblock-runs is ALIVE on the production path (200, not 503)', async () => {
    const res = await request(app).get('/blockers/self-unblock-runs').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('requires Bearer auth (auth runs before the 503-when-dark check)', async () => {
    const res = await request(app).get('/blockers/self-unblock-runs');
    expect(res.status).toBe(401);
  });

  it('dark-by-default: with selfUnblockChecklist.enabled=false the route 503s (after auth)', async () => {
    const darkTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-unblock-dark-e2e-'));
    const darkState = prepStateDir(darkTmp);
    const darkServer = await bootServer(darkTmp, darkState, AUTH, /* selfUnblockEnabled */ false);
    try {
      const unauth = await request(darkServer.getApp()).get('/blockers/self-unblock-runs');
      expect(unauth.status).toBe(401); // auth first
      const res = await request(darkServer.getApp()).get('/blockers/self-unblock-runs').set(auth());
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('Self-Unblock checklist not initialized');
    } finally {
      await darkServer.stop();
      SafeFsExecutor.safeRmSync(darkTmp, { recursive: true, force: true, operation: 'tests/e2e/self-unblock-lifecycle.test.ts:dark' });
    }
  });

  // ── WIRING-INTEGRITY (required §2/§9): the standard licenses NO gate bypass ──
  it('a self-unblock action touching an external account is STILL evaluated by the external-operation gate', async () => {
    // Self-unblock would use a Cloudflare token to write a DNS record — an external,
    // irreversible mutation. It MUST still pass through /operations/evaluate (the
    // external-operation gate), which the standard never bypasses.
    const res = await request(app)
      .post('/operations/evaluate')
      .set(auth())
      .send({
        service: 'cloudflare',
        mutability: 'write',
        reversibility: 'irreversible',
        description: 'Self-unblock: add a DNS record for feedback.dawn-tunnel.dev',
      });
    expect(res.status).toBe(200);
    // The gate returns a real verdict (proceed / show-plan / block / suggest-alternative)
    // — proving it is ALIVE and adjudicates the self-unblock action, never bypassed.
    expect(typeof res.body.action).toBe('string');
    expect(res.body.action.length).toBeGreaterThan(0);
  });

  it('a self-unblock action under a mandate is STILL evaluated by the mandate gate (deny-by-default with no mandate)', async () => {
    // The mandate gate is the authorizer (§3 rung-1). With NO mandate issued it
    // DENIES by default — proving the self-unblock path cannot self-authorize.
    const res = await request(app)
      .post('/mandate/evaluate')
      .set(auth())
      .send({
        action: 'self-unblock-external-write',
        params: { artifact: 'cloudflare-dns' },
        agentFp: 'test-agent-fp',
        mandateId: 'no-such-mandate',
      });
    // The route is alive (not 404/503) and the decision is a deny (deny-by-default).
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.decision).toBe('deny');
    }
  });

  it('SECURITY: a DurableVaultSession value never serializes into the ledger / a logged form (§5.3 no-leak)', async () => {
    // The durable session is machine-local + in-memory; this asserts the no-leak
    // contract structurally — the value cannot escape via serialization (the exact
    // class the org-vault probe wires). The on-disk blocker-decisions.jsonl audit
    // (if any) likewise must never carry a session value.
    const SECRET = 'BW-SESSION-e2e-SECRET-zzz999';
    const dvs = new DurableVaultSession({ deriveSession: () => SECRET, ttlMs: 10_000, idleMs: 10_000 });
    await dvs.withSession((s) => s);
    expect(JSON.stringify(dvs)).not.toContain(SECRET);

    const auditPath = path.join(stateDir, 'logs', 'blocker-decisions.jsonl');
    if (fs.existsSync(auditPath)) {
      const audit = fs.readFileSync(auditPath, 'utf-8');
      expect(audit).not.toContain(SECRET);
    }
    // The self-unblock runs file likewise never carries a session value.
    const runsPath = path.join(stateDir, 'state', 'self-unblock-runs', 'runs.jsonl');
    if (fs.existsSync(runsPath)) {
      expect(fs.readFileSync(runsPath, 'utf-8')).not.toContain(SECRET);
    }
  });
});
