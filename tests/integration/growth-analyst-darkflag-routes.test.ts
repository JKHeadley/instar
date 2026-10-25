/**
 * Tier-2 integration for R7 / Standards A + B: the dark-flag maturity signal
 * over the REAL HTTP pipeline (supertest + a real RouteContext), not just the
 * class in isolation.
 *
 * Both sides of every boundary: dark (no R7 in the payload), dry-run (durable
 * registry written, still no R7 in the payload), live (R7 findings + counts
 * reach the route), and the degrade path where the inventory is unreadable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { GrowthMilestoneAnalyst, resolveGrowthSettings } from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import { DarkFlagMaturationRegistry } from '../../src/monitoring/DarkFlagMaturationRegistry.js';
import type { GuardEffectiveState, GuardOffClass, GuardRow } from '../../src/monitoring/guardPostureView.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const fakeTracker = {
  list: () => [],
  digest: (now: Date) => ({ generatedAt: now.toISOString(), items: [] }),
} as any;

function row(
  key: string,
  effective: GuardEffectiveState = 'on-dry-run',
  offClass: GuardOffClass = null,
  extra: Partial<GuardRow> = {},
): GuardRow {
  return {
    key,
    configEnabled: null,
    defaultEnabled: null,
    effective,
    offClass,
    divergence: 'none',
    runtime: null,
    process: 'server',
    ...extra,
  } as GuardRow;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-routes-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/growth-analyst-darkflag-routes.test.ts' });
});

function analyst(opts: {
  enabled: boolean;
  dryRun: boolean;
  rows: GuardRow[] | null;
  proof?: (r: GuardRow) => number | undefined;
}) {
  return new GrowthMilestoneAnalyst({
    stateDir: tmp,
    settings: resolveGrowthSettings({
      enabled: true,
      darkFlagInventory: { enabled: opts.enabled, dryRun: opts.dryRun },
    } as any),
    tracker: fakeTracker,
    darkFlagInventory: () => opts.rows,
    darkFlagRegistry: new DarkFlagMaturationRegistry({ stateDir: tmp, machineId: 'm_int' }),
    ...(opts.proof ? { darkFlagEvidenceCounter: opts.proof } : {}),
  });
}

function appWith(a: GrowthMilestoneAnalyst): express.Express {
  const ctx = {
    config: { projectName: 'test', projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    startTime: new Date(),
    growthMilestoneAnalyst: a,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

const REGISTRY = () => path.join(tmp, 'state', 'dark-flag-maturation.json');

describe('GET /growth/digest — R7 over the real pipeline', () => {
  const rows = [
    row('monitoring.alpha.enabled'),
    row('monitoring.beta.enabled', 'off', 'dark-default'),
  ];

  it('carries NO R7 findings and writes NO registry while the feature is dark', async () => {
    const res = await request(appWith(analyst({ enabled: false, dryRun: true, rows }))).get('/growth/digest');
    expect(res.status).toBe(200);
    expect(res.body.findings.some((f: any) => f.rule === 'R7')).toBe(false);
    expect(res.body.counts.darkLegacyUnproven).toBe(0);
    expect(fs.existsSync(REGISTRY())).toBe(false);
  });

  it('writes the durable registry in dry-run but still carries no R7 findings', async () => {
    const res = await request(appWith(analyst({ enabled: true, dryRun: true, rows }))).get('/growth/digest');
    expect(res.status).toBe(200);
    expect(res.body.findings.some((f: any) => f.rule === 'R7')).toBe(false);
    expect(fs.existsSync(REGISTRY())).toBe(true);
    const saved = JSON.parse(fs.readFileSync(REGISTRY(), 'utf-8'));
    expect(Object.keys(saved.entries)).toHaveLength(2);
    expect(saved.machineId).toBe('m_int');
  });

  it('delivers R7 findings AND the dark counts once live', async () => {
    const res = await request(appWith(analyst({ enabled: true, dryRun: false, rows }))).get('/growth/digest');
    expect(res.status).toBe(200);
    const r7 = res.body.findings.filter((f: any) => f.rule === 'R7');
    expect(r7.length).toBeGreaterThan(0);
    expect(r7[0].affected).toBeInstanceOf(Array);
    expect(res.body.counts.darkLegacyUnproven).toBe(2);
    expect(res.body.counts.darkUnowned).toBe(2);
  });

  it('aggregates — the number of R7 rows never scales with the number of flags', async () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`monitoring.f${i}.enabled`));
    const res = await request(appWith(analyst({ enabled: true, dryRun: false, rows: many }))).get('/growth/digest');
    const r7 = res.body.findings.filter((f: any) => f.rule === 'R7');
    expect(r7).toHaveLength(1);
    expect(r7[0].affected).toHaveLength(60);
  });

  it('an unreadable inventory degrades to no R7 rather than reporting "nothing is dark"', async () => {
    const res = await request(appWith(analyst({ enabled: true, dryRun: false, rows: null }))).get('/growth/digest');
    expect(res.status).toBe(200);
    expect(res.body.findings.some((f: any) => f.rule === 'R7')).toBe(false);
    expect(res.body.counts.darkIncubating).toBe(0);
  });
});

describe('GET /growth/findings and /growth/status carry the new signal', () => {
  const rows = [row('monitoring.alpha.enabled')];

  it('/growth/findings includes the R7 aggregate row', async () => {
    const res = await request(appWith(analyst({ enabled: true, dryRun: false, rows }))).get('/growth/findings');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('R7');
  });

  it('/growth/status reports the dark counts and the resolved settings', async () => {
    const res = await request(appWith(analyst({ enabled: true, dryRun: false, rows }))).get('/growth/status');
    expect(res.status).toBe(200);
    expect(res.body.counts).toHaveProperty('darkLegacyUnproven');
    expect(res.body.settings.darkFlagInventory).toEqual({ enabled: true, dryRun: false });
  });

  it('/growth/status honestly reports the feature off when it is off', async () => {
    const res = await request(appWith(analyst({ enabled: false, dryRun: true, rows }))).get('/growth/status');
    expect(res.body.settings.darkFlagInventory).toEqual({ enabled: false, dryRun: true });
  });
});

describe('the durable record survives a restart — an in-memory soak cannot', () => {
  it('a second analyst over the SAME stateDir keeps the original anchor and deadline', async () => {
    const rows = [row('monitoring.persist.enabled')];
    await request(appWith(analyst({ enabled: true, dryRun: false, rows }))).get('/growth/digest');
    const first = JSON.parse(fs.readFileSync(REGISTRY(), 'utf-8'));
    const anchor = first.entries['monitoring.persist.enabled'].firstObservedDarkAt;
    const deadline = first.entries['monitoring.persist.enabled'].deadline;

    // Fresh analyst + fresh registry object over the same durable file.
    await request(appWith(analyst({ enabled: true, dryRun: false, rows }))).get('/growth/digest');
    const second = JSON.parse(fs.readFileSync(REGISTRY(), 'utf-8'));
    expect(second.entries['monitoring.persist.enabled'].firstObservedDarkAt).toBe(anchor);
    expect(second.entries['monitoring.persist.enabled'].deadline).toBe(deadline);
  });

  it('a guard that vanishes is tombstoned rather than dropped from the record', async () => {
    await request(appWith(analyst({ enabled: true, dryRun: false, rows: [row('monitoring.gone.enabled')] })))
      .get('/growth/digest');
    await request(appWith(analyst({ enabled: true, dryRun: false, rows: [] }))).get('/growth/digest');
    const saved = JSON.parse(fs.readFileSync(REGISTRY(), 'utf-8'));
    expect(saved.entries['monitoring.gone.enabled']).toBeDefined();
    expect(saved.entries['monitoring.gone.enabled'].state).toBe('killed');
    expect(saved.entries['monitoring.gone.enabled'].history.length).toBeGreaterThanOrEqual(2);
  });
});
