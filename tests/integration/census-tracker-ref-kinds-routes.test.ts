/**
 * Tier 2 — GET /decision-quality reports census debt correctly for the
 * fleet-stable tracker kind, through the REAL Express routes + authMiddleware.
 *
 * Spec: docs/specs/census-tracker-ref-kinds.md
 *
 * The claim under test is exactly the one in the spec's graduation criterion,
 * and it is asserted on the case that matters: an install with NO evolution
 * queue on disk — i.e. every machine that did not mint the old ACT id.
 * Before this change that machine reported all 49 as unverifiable (and, with
 * the queue file absent, adjudicated nothing at all).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { PROVENANCE_COVERAGE } from '../../src/data/provenanceCoverage.js';

const AUTH = 'test-census-tracker-refs';

let tmpDir: string | null = null;
let ledger: FeatureMetricsLedger | null = null;

afterEach(() => {
  try {
    ledger?.close?.();
  } catch {
    /* ledger already closed — nothing to reclaim */
  }
  ledger = null;
  if (tmpDir && fs.existsSync(tmpDir)) {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true,
      operation: 'tests/integration/census-tracker-ref-kinds-routes.test.ts',
    });
  }
  tmpDir = null;
});

function freshStateDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-refs-'));
  return tmpDir;
}

/** Write a real evolution action-queue.json, the machine-local case. */
function writeQueue(stateDir: string, actions: Array<{ id: string; status?: string }>): void {
  const dir = path.join(stateDir, 'state', 'evolution');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'action-queue.json'),
    JSON.stringify({ actions: actions.map((a) => ({ status: 'pending', ...a })) }),
  );
}

function appFor(stateDir: string): express.Express {
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  const ctx = {
    config: {
      projectName: 'test',
      projectDir: '/tmp',
      stateDir,
      port: 0,
      authToken: AUTH,
      developmentAgent: true,
      provenance: { uniformSeam: { dryRun: false } },
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    featureMetricsLedger: ledger,
    startTime: new Date(),
  } as unknown as RouteContext;

  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));
  return app;
}

const PENDING_TOTAL = PROVENANCE_COVERAGE.filter((e) => e.status.startsWith('pending:')).length;

describe('GET /decision-quality — census debt for fleet-stable tracker refs', () => {
  it('reports ZERO unverifiable on an install with no evolution queue (the fleet case)', async () => {
    const stateDir = freshStateDir(); // deliberately no action-queue.json
    const res = await request(appFor(stateDir))
      .get('/decision-quality?sinceHours=24')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    const debt = res.body.censusDebt;
    expect(debt, 'censusDebt must be present').toBeTruthy();

    // The whole claim of this change, on the machine it was broken for.
    // Both surface as ARRAYS of "<decisionPoint>:<ref>" — the emptiness IS the claim.
    expect(debt.pendingRefUnverifiable, JSON.stringify(debt.pendingRefUnverifiable)).toEqual([]);
    expect(debt.pendingRefDead, JSON.stringify(debt.pendingRefDead)).toEqual([]);

    // And the backlog itself did NOT shrink — the count is honest, not gamed.
    expect(debt.pending).toBe(PENDING_TOTAL);
  });

  it('reports the same ZERO with a populated queue that has never seen ACT-1193', async () => {
    // A peer machine whose own queue is real but low-numbered. Under the old
    // ref this reported 49 unverifiable; the verdict must not depend on it.
    const stateDir = freshStateDir();
    writeQueue(stateDir, [{ id: 'ACT-1' }, { id: 'ACT-2' }, { id: 'ACT-3' }]);

    const res = await request(appFor(stateDir))
      .get('/decision-quality?sinceHours=24')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.censusDebt.pendingRefUnverifiable).toEqual([]);
    expect(res.body.censusDebt.pendingRefDead).toEqual([]);
    expect(res.body.censusDebt.pending).toBe(PENDING_TOTAL);
  });

  it('the debt block still answers the other census questions (no collateral change)', async () => {
    const stateDir = freshStateDir();
    const res = await request(appFor(stateDir))
      .get('/decision-quality?sinceHours=24')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    const debt = res.body.censusDebt;
    expect(typeof debt.wired).toBe('number');
    expect(typeof debt.exempt).toBe('number');
    expect(debt.wired).toBeGreaterThan(0);
    expect(debt.wired + debt.pending + debt.exempt).toBe(PROVENANCE_COVERAGE.length);
  });

  it('still requires Bearer auth (the census is not public)', async () => {
    const stateDir = freshStateDir();
    const res = await request(appFor(stateDir)).get('/decision-quality');
    expect(res.status).toBe(401);
  });
});
