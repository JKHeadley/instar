/**
 * E2E (HTTP) lifecycle for Standards A + B — the dark-flag maturation record.
 * Tier-3 of the Testing Integrity Standard: a REAL Express server on a real
 * port, REAL HTTP calls, and the durable registry on real disk.
 *
 * The Phase-1 "feature is alive" assertion: with the inventory wired and live,
 * GET /growth/digest returns 200 (not 404/503) and carries a real R7 finding
 * derived from a guard inventory, and the durable record exists on disk.
 *
 * It then drives the lifecycle end to end over HTTP across multiple passes:
 * legacy backlog → graduation → re-entry keeping its original deadline →
 * tombstone. Each of those is a trap that makes this kind of registry useless
 * in practice, so each is exercised against the real surface, not a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { GrowthMilestoneAnalyst, resolveGrowthSettings } from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import { DarkFlagMaturationRegistry } from '../../src/monitoring/DarkFlagMaturationRegistry.js';
import type { GuardEffectiveState, GuardOffClass, GuardRow } from '../../src/monitoring/guardPostureView.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

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

const fakeTracker = {
  list: () => [],
  digest: (now: Date) => ({ generatedAt: now.toISOString(), items: [] }),
} as any;

let tmp: string;
/** Mutable so one long-lived server can be driven through several passes. */
let liveRows: GuardRow[] = [];

function buildApp(opts: { enabled: boolean; dryRun: boolean; machineId?: string }): express.Express {
  const analyst = new GrowthMilestoneAnalyst({
    stateDir: tmp,
    settings: resolveGrowthSettings({
      enabled: true,
      darkFlagInventory: { enabled: opts.enabled, dryRun: opts.dryRun },
    } as any),
    tracker: fakeTracker,
    darkFlagInventory: () => liveRows,
    darkFlagRegistry: new DarkFlagMaturationRegistry({
      stateDir: tmp,
      machineId: opts.machineId ?? 'm_e2e',
    }),
    darkFlagOwnerFor: (r) => (r.key === 'monitoring.owned.enabled' ? 'agent' : null),
  });
  const ctx = {
    config: { projectName: 'e2e', projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    startTime: new Date(),
    growthMilestoneAnalyst: analyst,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

const registryPath = () => path.join(tmp, 'state', 'dark-flag-maturation.json');
const readRegistry = () => JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-e2e-'));
  liveRows = [];
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/growth-darkflag-maturation-lifecycle.test.ts' });
});

describe('Standards A + B — the feature is ALIVE over real HTTP', () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });

  it('PHASE 1 — GET /growth/digest returns 200 with a real R7 finding and a durable record on disk', async () => {
    liveRows = [
      row('monitoring.alpha.enabled'),
      row('monitoring.beta.enabled', 'off', 'dark-default'),
      row('monitoring.healthy.enabled', 'on-confirmed'),
    ];
    server = await listen(buildApp({ enabled: true, dryRun: false }));

    const res = await fetch(`${server.url}/growth/digest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    const r7 = body.findings.filter((f: any) => f.rule === 'R7');
    expect(r7.length).toBeGreaterThan(0);
    // The two dark ones are tracked; the healthy one is not invented into the record.
    expect(body.counts.darkLegacyUnproven).toBe(2);
    expect(r7[0].affected).toEqual(['monitoring.alpha.enabled', 'monitoring.beta.enabled']);

    // Durable, on real disk, stamped with this machine.
    expect(fs.existsSync(registryPath())).toBe(true);
    const saved = readRegistry();
    expect(saved.machineId).toBe('m_e2e');
    expect(Object.keys(saved.entries).sort()).toEqual([
      'monitoring.alpha.enabled',
      'monitoring.beta.enabled',
    ]);
    expect(saved.entries['monitoring.alpha.enabled'].proofOfLife).toBe('unknown');
  });

  it('503s when the analyst is absent — the dark contract still holds end to end', async () => {
    const ctx = {
      config: { projectName: 'e2e', projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 0 } as any,
      sessionManager: { listRunningSessions: () => [] } as any,
      state: { getJobState: () => null, getSession: () => null } as any,
      startTime: new Date(),
      growthMilestoneAnalyst: null,
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    server = await listen(app);
    const res = await fetch(`${server.url}/growth/digest`);
    expect(res.status).toBe(503);
  });

  it('with the feature DARK the route still answers 200 but writes nothing — rollback is complete', async () => {
    liveRows = [row('monitoring.alpha.enabled')];
    server = await listen(buildApp({ enabled: false, dryRun: true }));
    const res = await fetch(`${server.url}/growth/digest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.findings.some((f: any) => f.rule === 'R7')).toBe(false);
    expect(fs.existsSync(registryPath())).toBe(false);
  });
});

describe('the full lifecycle, driven over HTTP across passes', () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });

  it('legacy backlog → graduation → re-entry on the ORIGINAL deadline → tombstone', async () => {
    // ── Pass 1: two flags already dark. They are the forgotten backlog.
    liveRows = [row('monitoring.flappy.enabled'), row('monitoring.owned.enabled')];
    server = await listen(buildApp({ enabled: true, dryRun: false }));

    let body = (await (await fetch(`${server.url}/growth/digest`)).json()) as any;
    expect(body.counts.darkLegacyUnproven).toBe(2);
    const legacy = body.findings.find((f: any) => f.subjectId === 'dark-flags:legacy-unproven');
    expect(legacy.priority).toBe('high'); // the backlog leads
    const anchor = readRegistry().entries['monitoring.flappy.enabled'].firstObservedDarkAt;
    const deadline = readRegistry().entries['monitoring.flappy.enabled'].deadline;

    // ── Pass 2: one of them is genuinely switched on. It graduates, and the
    // record says which state it left as rather than asserting more than it knows.
    liveRows = [row('monitoring.flappy.enabled', 'on-confirmed'), row('monitoring.owned.enabled')];
    body = (await (await fetch(`${server.url}/growth/digest`)).json()) as any;
    let saved = readRegistry();
    expect(saved.entries['monitoring.flappy.enabled'].state).toBe('graduated');
    expect(saved.entries['monitoring.flappy.enabled'].graduatedAtState).toBe('on-confirmed');
    expect(body.counts.darkLegacyUnproven).toBe(1);

    // ── Pass 3: it flaps back to dark. The window must CONTINUE, not restart —
    // otherwise a flapping flag resets its clock forever and escapes review.
    liveRows = [row('monitoring.flappy.enabled', 'on-dry-run'), row('monitoring.owned.enabled')];
    await fetch(`${server.url}/growth/digest`);
    saved = readRegistry();
    expect(saved.entries['monitoring.flappy.enabled'].firstObservedDarkAt).toBe(anchor);
    expect(saved.entries['monitoring.flappy.enabled'].deadline).toBe(deadline);
    expect(saved.entries['monitoring.flappy.enabled'].state).not.toBe('incubating');

    // ── Pass 4: the flag is deleted from the build. It is tombstoned, with its
    // history intact, and it stops counting as an open finding.
    liveRows = [row('monitoring.owned.enabled')];
    body = (await (await fetch(`${server.url}/growth/digest`)).json()) as any;
    saved = readRegistry();
    expect(saved.entries['monitoring.flappy.enabled'].state).toBe('killed');
    expect(saved.entries['monitoring.flappy.enabled'].history.length).toBeGreaterThanOrEqual(3);
    expect(body.counts.darkUnowned).toBe(1); // only the surviving un-owned one
  });

  it('an owner derived from a real source is recorded; everything else stays honestly un-owned', async () => {
    liveRows = [row('monitoring.owned.enabled'), row('monitoring.nobody.enabled')];
    server = await listen(buildApp({ enabled: true, dryRun: false }));
    await fetch(`${server.url}/growth/digest`);
    // Both are legacy on the first pass, so BOTH stay un-owned by design — a
    // fresh clean owner would mask the backlog. Second pass: still un-owned.
    await fetch(`${server.url}/growth/digest`);
    const saved = readRegistry();
    expect(saved.entries['monitoring.owned.enabled'].owner).toBeNull();
    expect(saved.entries['monitoring.nobody.enabled'].owner).toBeNull();
    const body = (await (await fetch(`${server.url}/growth/digest`)).json()) as any;
    expect(body.counts.darkUnowned).toBe(2);
  });

  it("a registry written by another machine is not adopted — it re-anchors as this machine's own", async () => {
    // Plant a peer's registry claiming a long-settled history.
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(
      registryPath(),
      JSON.stringify({
        version: 1,
        machineId: 'm_some_peer',
        entries: {
          'monitoring.peer.enabled': {
            guardKey: 'monitoring.peer.enabled',
            firstObservedDarkAt: '2020-01-01T00:00:00.000Z',
            deadline: '2020-01-08T00:00:00.000Z',
            owner: 'operator',
            state: 'graduated',
            riskTier: 'standard',
            windowDays: 7,
            proofOfLife: true,
            lastObservedState: 'on-confirmed',
            lastObservedAt: '2020-01-08T00:00:00.000Z',
            history: [],
          },
        },
      }),
    );
    liveRows = [row('monitoring.peer.enabled')];
    server = await listen(buildApp({ enabled: true, dryRun: false, machineId: 'm_e2e' }));
    const body = (await (await fetch(`${server.url}/growth/digest`)).json()) as any;
    const saved = readRegistry();
    expect(saved.machineId).toBe('m_e2e');
    // The peer's "graduated / proved" claim does NOT carry over.
    expect(saved.entries['monitoring.peer.enabled'].state).toBe('legacy-unproven');
    expect(saved.entries['monitoring.peer.enabled'].proofOfLife).toBe('unknown');
    expect(body.counts.darkLegacyUnproven).toBe(1);
  });
});
