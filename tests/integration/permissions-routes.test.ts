/**
 * Integration tests for the Slack org permission routes behind the real Express router:
 *   GET /permissions/scenario-suite — the deterministic demonstration (Pillar 4 Layer-A)
 *   GET /permissions/decisions      — the observe-only decision ledger
 *
 * Spec: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.10, §8, §11.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PermissionDecisionLedger } from '../../src/permissions/PermissionDecisionLedger.js';
import { RelationshipBehaviorStore } from '../../src/permissions/RelationshipBehaviorStore.js';
import { buildSliceZeroGate, CAST } from '../../src/permissions/testing/SlackScenarioHarness.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';

let tmp: string | null = null;

function ctxWith(stateDir: string): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(stateDir: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(stateDir)));
  return app;
}

afterEach(() => {
  if (tmp) {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/permissions-routes.test.ts' });
    tmp = null;
  }
});

describe('GET /permissions/scenario-suite (integration)', () => {
  it('runs the full demonstration and reports all passing', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const res = await request(appWith(tmp)).get('/permissions/scenario-suite');

    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(8);
    expect(res.body.summary.passed).toBe(8);
    expect(res.body.summary.failed).toBe(0);
    expect(res.body.rows).toHaveLength(8);

    const stepUp = res.body.rows.find((r: any) => r.id === '5-spoofed-ceo');
    expect(stepUp.got).toBe('step-up/anomaly-stepup');
    expect(stepUp.pass).toBe(true);

    // The two deterministic-subset rows the milestone adds.
    const granted = res.body.rows.find((r: any) => r.id === '7-granted-member-floor');
    expect(granted.got).toBe('allow/floor-granted');
    expect(granted.pass).toBe(true);
    const outsider = res.body.rows.find((r: any) => r.id === '8-unregistered-outsider');
    expect(outsider.got).toBe('refuse/unregistered');
    expect(outsider.pass).toBe(true);
  });
});

describe('POST /permissions/scenario-suite/run (integration — audit-asserting, "verified not narrated")', () => {
  it('runs every row through resolver→gate→ledger and asserts BOTH verdict and audit entry', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const res = await request(appWith(tmp)).post('/permissions/scenario-suite/run');

    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(8);
    expect(res.body.summary.passed).toBe(8);
    expect(res.body.summary.failed).toBe(0);
    expect(res.body.rows).toHaveLength(8);

    // Every row must have BOTH the verdict AND the audit entry — the property that
    // makes the demonstration self-verified rather than narrated.
    for (const row of res.body.rows) {
      expect(row.verdictOk).toBe(true);
      expect(row.auditOk).toBe(true);
      expect(row.pass).toBe(true);
    }
    // The run writes into a throwaway temp dir — NEVER the agent's real stateDir.
    expect(res.body.ledgerPath).not.toContain(tmp!);
  });
});

describe('GET /permissions/decisions (integration)', () => {
  it('returns the observe-only decision ledger rows', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    // Seed the ledger with a real verdict.
    const ledger = new PermissionDecisionLedger(tmp);
    const verdict = await buildSliceZeroGate().evaluate({
      principal: CAST.memberMaya,
      text: 'deploy to prod',
      directed: true,
      channel: 'C1',
    });
    ledger.record(verdict, { channel: 'C1', enforced: false });

    const res = await request(appWith(tmp)).get('/permissions/decisions');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.decisions)).toBe(true);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0].basis).toBe('floor-no-grant');
    expect(res.body.decisions[0].enforced).toBe(false);
  });

  it('returns an empty list (not an error) when no decisions exist yet', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const res = await request(appWith(tmp)).get('/permissions/decisions');
    expect(res.status).toBe(200);
    expect(res.body.decisions).toEqual([]);
  });
});

describe('GET /permissions/ambient-stats (integration — Cleanup #2 observability)', () => {
  it('returns { present: false } when no Slack adapter / ambient gate is attached', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const res = await request(appWith(tmp)).get('/permissions/ambient-stats');
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(false);
  });

  it('surfaces the ambient aggregate from the live Slack adapter when attached', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const app = express();
    app.use(express.json());
    const ctx = ctxWith(tmp);
    // Stub a Slack adapter exposing getAmbientStats() (the live passthrough).
    (ctx as any).slack = {
      getAmbientStats: () => ({
        channels: [{ channelId: 'C1', evaluated: 3, spoke: 1, silent: 2, nearMissSilent: 1, silentByReason: { 'low-confidence': 1, 'llm-declined': 1 } }],
        recentNearMisses: [{ channelId: 'C1', reason: 'low-confidence', confidence: 0.8, nearMiss: true, at: 123 }],
        nearMissDelta: 0.1, minConfidence: 0.85, ringCapacity: 50,
      }),
    };
    app.use('/', createRoutes(ctx));
    const res = await request(app).get('/permissions/ambient-stats');
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.stats.channels[0].silent).toBe(2);
    expect(res.body.stats.channels[0].nearMissSilent).toBe(1);
    expect(res.body.stats.recentNearMisses).toHaveLength(1);
  });
});

describe('GET /permissions/baselines (integration — Pillar 3)', () => {
  it('returns the per-principal behavioral baselines (SHAPE only, never content)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const store = new RelationshipBehaviorStore(tmp);
    for (let i = 0; i < 6; i++) store.record('U_OLIVIA', { action: 'read', tier: 1, hour: 10, length: 30, urgent: false });

    const res = await request(appWith(tmp)).get('/permissions/baselines');
    expect(res.status).toBe(200);
    expect(res.body.baselines.U_OLIVIA.interactionCount).toBe(6);
    expect(res.body.baselines.U_OLIVIA.actionCounts.read).toBe(6);
    // No message content anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toMatch(/summarize|the incident|message text/i);
  });

  it('returns a single principal baseline via ?slackUserId, and null for an unknown one', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const store = new RelationshipBehaviorStore(tmp);
    store.record('U_AMIR', { action: 'operational', tier: 3, hour: 14, length: 40, urgent: false });

    const found = await request(appWith(tmp)).get('/permissions/baselines?slackUserId=U_AMIR');
    expect(found.status).toBe(200);
    expect(found.body.baseline.interactionCount).toBe(1);

    const missing = await request(appWith(tmp)).get('/permissions/baselines?slackUserId=U_NOBODY');
    expect(missing.status).toBe(200);
    expect(missing.body.baseline).toBeNull();
  });

  it('returns an empty object (not an error) when no baselines exist yet', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const res = await request(appWith(tmp)).get('/permissions/baselines');
    expect(res.status).toBe(200);
    expect(res.body.baselines).toEqual({});
  });
});

describe('GET /permissions/users (integration) — the grant form person picker', () => {
  function seedUsers(stateDir: string, users: unknown[]): void {
    // These fixtures use known test-identity ids (U_MIA/U_ADAM); enable the
    // double-keyed test escape so they load in this throwaway state dir.
    allowTestIdentities(stateDir);
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify(users, null, 2));
  }

  it('returns ONLY users carrying a Slack identity, with name + orgRole', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    seedUsers(tmp, [
      { id: 'slack-U_MIA', name: 'Mia Member', channels: [{ type: 'slack', identifier: 'U_MIA' }], permissions: ['member'], preferences: {}, slackUserId: 'U_MIA', orgRole: 'member', createdAt: 'x' },
      { id: 'slack-U_ADAM', name: 'Adam Admin', channels: [{ type: 'slack', identifier: 'U_ADAM' }], permissions: ['member'], preferences: {}, slackUserId: 'U_ADAM', orgRole: 'admin', createdAt: 'x' },
      { id: 'tg-justin', name: 'Justin', channels: [{ type: 'telegram', identifier: '123' }], permissions: ['admin'], preferences: {}, createdAt: 'x' },
    ]);
    const res = await request(appWith(tmp)).get('/permissions/users');
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2); // the Telegram-only user is excluded
    const mia = res.body.users.find((u: any) => u.slackUserId === 'U_MIA');
    expect(mia).toEqual({ slackUserId: 'U_MIA', name: 'Mia Member', orgRole: 'member' });
    // Read-only person picker: no channel identifiers, permissions, or preferences leak.
    expect(JSON.stringify(res.body)).not.toMatch(/telegram|preferences|permissions"/);
  });

  it('returns an empty list (not an error) when no users exist yet', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const res = await request(appWith(tmp)).get('/permissions/users');
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it('tolerates a user record without orgRole (null, not missing)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    seedUsers(tmp, [
      { id: 'slack-U_X', name: 'X', channels: [{ type: 'slack', identifier: 'U_X' }], permissions: [], preferences: {}, slackUserId: 'U_X', createdAt: 'x' },
    ]);
    const res = await request(appWith(tmp)).get('/permissions/users');
    expect(res.status).toBe(200);
    expect(res.body.users[0]).toEqual({ slackUserId: 'U_X', name: 'X', orgRole: null });
  });
});
