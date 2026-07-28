/**
 * §5.6 census debt — ACT-kind pending-tracker adjudication through the REAL route
 * (the 2026-07-23 false-alarm fix's route-level guard).
 *
 * WHY THIS FILE EXISTS SEPARATELY (census-tracker-ref-kinds, 2026-07-25).
 * These assertions used to live in decision-quality-routes.test.ts and drove the
 * ACT semantics through whatever `PROVENANCE_COVERAGE` happened to contain — at
 * the time, 49 entries all citing `ACT-1193`. That coupling was incidental, and
 * repointing those entries to the fleet-stable `backlog:` kind broke three of
 * them and — worse — made two others pass VACUOUSLY, asserting empty lists that
 * nothing could populate any more.
 *
 * A test whose subject can silently evaporate is not guarding anything. So the
 * census is now INJECTED here: the ACT semantics are exercised against a
 * synthetic ACT-ref entry that cannot drift when the real backlog is repointed
 * or drained. The guarantee is preserved permanently rather than accidentally.
 *
 * The module mock is file-scoped, which is exactly why this is its own file —
 * the sibling suite must keep reading the real census.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ACT_REF = 'ACT-1193';

// One synthetic pending entry carrying an ACT ref, plus one wired entry so the
// debt block is shaped like a real census. Everything else is irrelevant here.
vi.mock('../../src/data/provenanceCoverage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/data/provenanceCoverage.js')>();
  return {
    ...actual,
    PROVENANCE_COVERAGE: [
      {
        decisionPoint: 'synthetic-act-point',
        component: 'SyntheticActComponent',
        category: 'gate',
        status: `pending:${ACT_REF}`,
        reason:
          'Synthetic fixture pinning the ACT-kind adjudication path through the real route.',
      },
      ...actual.PROVENANCE_COVERAGE.filter((e) => e.status === 'wired').slice(0, 1),
    ],
  };
});

const { createRoutes } = await import('../../src/server/routes.js');
const { authMiddleware } = await import('../../src/server/middleware.js');
const { FeatureMetricsLedger } = await import('../../src/monitoring/FeatureMetricsLedger.js');

const AUTH = 'test-act-tracker';
let tmpDir: string | null = null;
let ledger: InstanceType<typeof FeatureMetricsLedger> | null = null;

afterEach(() => {
  try {
    ledger?.close?.();
  } catch {
    /* already closed — nothing to reclaim */
  }
  ledger = null;
  if (tmpDir && fs.existsSync(tmpDir)) {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/decision-quality-act-tracker-routes.test.ts',
    });
  }
  tmpDir = null;
});

function writeQueue(actions: Array<{ id: string; status: string }>): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-act-'));
  const dir = path.join(tmpDir, 'state', 'evolution');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'action-queue.json'), JSON.stringify({ actions }));
}

async function censusDebt(): Promise<Record<string, any>> {
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  const ctx = {
    config: {
      projectName: 'test', projectDir: '/tmp', stateDir: tmpDir ?? '/tmp/.instar', port: 0,
      authToken: AUTH, developmentAgent: true,
      provenance: { uniformSeam: { dryRun: false } },
      sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    featureMetricsLedger: ledger,
    startTime: new Date(),
  } as any;

  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));

  const res = await request(app).get('/decision-quality').set('Authorization', `Bearer ${AUTH}`);
  expect(res.status).toBe(200);
  return res.body.censusDebt;
}

describe('GET /decision-quality censusDebt — ACT-kind adjudication (injected census)', () => {
  it('the fixture is real — exactly one pending ACT entry is under test', async () => {
    // Guards the guard: if the mock ever stops injecting, every assertion below
    // would go vacuously green. This is the check that makes that impossible.
    writeQueue([{ id: 'ACT-1119', status: 'pending' }]);
    const debt = await censusDebt();
    expect(debt.pending).toBe(1);
  });

  it("a tracker ABOVE this machine's high-water reads unverifiable, never dead (the peer-minted case)", async () => {
    // High-water 1119 < 1193 ⇒ this machine never minted that far: minted elsewhere.
    writeQueue([{ id: 'ACT-1119', status: 'pending' }, { id: 'ACT-0004', status: 'completed' }]);
    const debt = await censusDebt();
    expect(debt.pendingRefDead).toEqual([]);
    expect(debt.pendingRefUnverifiable.length).toBe(debt.pending);
    expect(debt.pendingRefUnverifiable[0]).toContain(ACT_REF);
  });

  it('a tracker WITHIN high-water range but absent still reads dead (the genuine-deletion signal survives)', async () => {
    // High-water 1211 > 1193 and 1193 is absent ⇒ genuinely deleted here.
    writeQueue([{ id: 'ACT-1211', status: 'pending' }]);
    const debt = await censusDebt();
    expect(debt.pendingRefUnverifiable).toEqual([]);
    expect(debt.pendingRefDead.length).toBe(debt.pending);
    expect(debt.pendingRefDead[0]).toContain(ACT_REF);
  });

  it('a tracker that is alive locally is flagged by neither list', async () => {
    writeQueue([{ id: ACT_REF, status: 'pending' }, { id: 'ACT-1211', status: 'completed' }]);
    const debt = await censusDebt();
    expect(debt.pending).toBe(1); // non-vacuous: there IS an entry that could have been flagged
    expect(debt.pendingRefDead).toEqual([]);
    expect(debt.pendingRefUnverifiable).toEqual([]);
  });

  it('a TERMINAL tracker within range reads dead (completed ≠ alive), and high-water still counts it', async () => {
    writeQueue([{ id: ACT_REF, status: 'completed' }]);
    const debt = await censusDebt();
    // high-water is 1193 (terminal rows count toward high-water), 1193 is NOT > 1193 ⇒ dead.
    expect(debt.pendingRefUnverifiable).toEqual([]);
    expect(debt.pendingRefDead.length).toBe(debt.pending);
  });

  it('an absent queue reads unverifiable, never dead (a fresh agent is never false-flagged)', async () => {
    // Behaviour CHANGE, deliberate: the route used to skip adjudication entirely
    // when no queue existed, so both lists were empty. The null case now lives in
    // the adjudicator, and for a machine-local ACT ref the honest answer to "is
    // this alive?" with no queue to consult is `unverifiable` — never `dead`.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-act-noqueue-'));
    const debt = await censusDebt();
    expect(debt.pending).toBe(1);
    expect(debt.pendingRefDead).toEqual([]);
    expect(debt.pendingRefUnverifiable.length).toBe(1);
  });
});
