/**
 * Tier-2 integration: trust-journey stage 0, decision 4, over the real HTTP pipeline.
 * A request carrying only the agent's token (or the dashboard PIN) cannot widen trust, the autonomy
 * profile, the gate config, evolution autonomy, Slack owner/admin roles or the board policy; it gets
 * 403 operator-approval-required naming the approval. Narrowing still applies. Agent-reported
 * approval rows are labelled and never count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { TrustElevationTracker } from '../../src/core/TrustElevationTracker.js';
import { ApprovalLedger } from '../../src/core/ApprovalLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

let dir: string;
let projectDir: string;
let stateDir: string;
let configPath: string;
let app: express.Express;
let trust: AdaptiveTrust;
let autonomy: AutonomyProfileManager;
let tracker: TrustElevationTracker;
let ledger: ApprovalLedger;

const startConfig = {
  externalOperations: { enabled: true, services: { gmail: { permissions: ['read', 'write'], blocked: ['delete'] } }, readOnlyServices: ['calendar'] },
  evolution: { approvalMode: 'ai-assisted' },
  tunnel: { enabled: false },
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-raise-routes-'));
  projectDir = dir;
  stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(startConfig, null, 2));
  const config = { projectName: 'test', projectDir, stateDir, port: 0, users: [], agentAutonomy: { level: 'collaborative' } } as unknown as InstarConfig;
  trust = new AdaptiveTrust({ stateDir });
  autonomy = new AutonomyProfileManager({ stateDir, config });
  tracker = new TrustElevationTracker({ stateDir });
  ledger = new ApprovalLedger({ filePath: path.join(stateDir, 'approval-ledger.jsonl'), sign: (c) => `s:${c}`, verifySig: (c, s) => s === `s:${c}` });
  const ctx = {
    config, adaptiveTrust: trust, autonomyManager: autonomy, trustElevationTracker: tracker, approvalLedger: ledger,
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    startTime: new Date(),
  } as unknown as RouteContext;
  app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/trust-raise-refusal-routes.test.ts' }); });

const fileConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));

describe('POST /trust/grant', () => {
  it('a raise is refused with 403 naming the approval, and nothing changes', async () => {
    const r = await request(app).post('/trust/grant').send({ service: 'gmail', operation: 'write', level: 'autonomous', statement: 'go' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('operator-approval-required');
    expect(r.body.needs).toMatch(/approve <code>/);
    expect(trust.getTrustLevel('gmail', 'write').source).toBe('default');
  });
  it('a narrowing applies', async () => {
    const r = await request(app).post('/trust/grant').send({ service: 'gmail', operation: 'write', level: 'approve-always', statement: 'ask me first' });
    expect(r.status).toBe(200);
    expect(trust.getTrustLevel('gmail', 'write').level).toBe('approve-always');
  });
  it('an unknown level is a 400, never treated as a narrowing', async () => {
    const r = await request(app).post('/trust/grant').send({ service: 'gmail', operation: 'write', level: 'whatever', statement: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('POST /autonomy/profile', () => {
  it('a wider profile is refused and the profile is unchanged', async () => {
    const before = autonomy.getProfile();
    const r = await request(app).post('/autonomy/profile').send({ profile: 'autonomous', reason: 'go' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('operator-approval-required');
    expect(autonomy.getProfile()).toBe(before);
  });
  it('a stricter profile applies', async () => {
    const r = await request(app).post('/autonomy/profile').send({ profile: 'cautious', reason: 'careful' });
    expect(r.status).toBe(200);
    expect(autonomy.getProfile()).toBe('cautious');
  });
});

describe('PATCH /config', () => {
  it('turning off the gate is refused and the file is untouched', async () => {
    const r = await request(app).patch('/config').send({ externalOperations: { enabled: false } });
    expect(r.status).toBe(403);
    expect(r.body.raises).toContain('turning off the external-operation gate');
    expect(fileConfig()).toEqual(startConfig);
  });
  it('replacing the services map so a block disappears is refused', async () => {
    const r = await request(app).patch('/config').send({ externalOperations: { services: { gmail: { permissions: ['read', 'write'] } } } });
    expect(r.status).toBe(403);
    expect(r.body.raises).toContain('unblocking delete on gmail');
  });
  it('emptying read-only services or self-approving evolution is refused', async () => {
    expect((await request(app).patch('/config').send({ externalOperations: { readOnlyServices: [] } })).status).toBe(403);
    expect((await request(app).patch('/config').send({ evolution: { approvalMode: 'autonomous' } })).status).toBe(403);
    expect(fileConfig()).toEqual(startConfig);
  });
  it('a restriction and an ungoverned key still apply', async () => {
    // SEC-163: switching the tunnel on is now a raise, so the ungoverned key here is publishing.
    const r = await request(app).patch('/config').send({ externalOperations: { readOnlyServices: ['calendar', 'slack'] }, publishing: { enabled: true } });
    expect(r.status).toBe(200);
    expect(fileConfig().externalOperations.readOnlyServices).toEqual(['calendar', 'slack']);
    expect(fileConfig().publishing.enabled).toBe(true);
  });
  it('SEC-163: switching the tunnel on with the key alone is refused', async () => {
    const r = await request(app).patch('/config').send({ tunnel: { enabled: true } });
    expect(r.status).toBe(403);
    expect(r.body.raises).toContain('turning on the public tunnel');
    expect(fileConfig().tunnel.enabled).toBe(false);
  });
});

describe('PATCH /config: switching a guard off (SEC-162)', () => {
  it('a monitoring guard, the input guard and the response review switched off are refused, and nothing is written', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...startConfig, monitoring: { watchdog: { enabled: true } }, responseReview: { enabled: true } }, null, 2));
    const before = fileConfig();
    const g = await request(app).patch('/config').send({ monitoring: { watchdog: { enabled: false } } });
    expect(g.status).toBe(403);
    expect(g.body.error).toBe('operator-approval-required');
    expect(g.body.raises).toContain('turning off the watchdog guard');
    expect((await request(app).patch('/config').send({ inputGuard: { enabled: false } })).status).toBe(403);
    expect((await request(app).patch('/config').send({ responseReview: { enabled: false } })).status).toBe(403);
    expect(fileConfig()).toEqual(before);
  });
  it('switching a guard on, and tuning one that stays on, still apply', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...startConfig, monitoring: { watchdog: { enabled: false } } }, null, 2));
    const on = await request(app).patch('/config').send({ monitoring: { watchdog: { enabled: true, intervalMs: 60000 } } });
    expect(on.status).toBe(200);
    expect(fileConfig().monitoring.watchdog).toEqual({ enabled: true, intervalMs: 60000 });
  });
});

describe('Slack roles', () => {
  it('registering or approving owner/admin is refused; member is not', async () => {
    expect((await request(app).post('/permissions/registrations/register').send({ slackUserId: 'U1', displayName: 'A', role: 'owner' })).status).toBe(403);
    expect((await request(app).post('/permissions/registrations/approve').send({ slackUserId: 'U1', role: 'admin' })).status).toBe(403);
    const ok = await request(app).post('/permissions/registrations/register').send({ slackUserId: 'U2', displayName: 'B', role: 'member' });
    expect(ok.status).toBe(200);
  });
});

describe('the signal routes', () => {
  it('POST /approvals stores the row as agent-reported whatever approver it names, and it never makes the class eligible', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await request(app).post('/approvals').send({ subject: `s${i}`, decisionClass: 'trust', mode: 'approved-as-is', approver: 'justin' });
      expect(r.status).toBe(201);
      expect(r.body.row.approver).toBe('agent-reported');
      expect(r.body.row.provenance).toBe('agent-reported');
      expect(r.body.row.reportedApprover).toBe('justin');
    }
    expect(ledger.summaryForClass('trust').autoApprovalEligible).toBe(false);
    expect(ledger.summaryForClass('trust').agentReported).toBe(6);
  });
  it('a provenance in the body cannot claim person-verified', async () => {
    const r = await request(app).post('/approvals').send({ subject: 'x', decisionClass: 'trust', mode: 'approved-as-is', provenance: 'person-verified' });
    expect(r.body.row.provenance).toBe('agent-reported');
  });
  it('elevation rows from the token are kept but left out of acceptance stats', async () => {
    const r = await request(app).post('/autonomy/elevation/record').send({ proposalId: 'p1', proposedAt: new Date(Date.now() - 60000).toISOString(), decision: 'approved' });
    expect(r.status).toBe(200);
    expect(r.body.acceptanceStats.totalDecided).toBe(0);
  });
  it('hiding the rubber-stamp signal is refused', async () => {
    const r = await request(app).post('/autonomy/elevation/dismiss-rubber-stamp').send({});
    expect(r.status).toBe(403);
    expect(tracker.getRubberStampSignal().dismissedUntil ?? null).toBeNull();
  });
});
