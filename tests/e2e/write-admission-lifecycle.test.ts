// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * E2E "feature is alive" lifecycle for standby-write reconciliation
 * (docs/specs/standby-write-reconciliation.md §8 Tier 3).
 *
 * Mirrors the PRODUCTION wiring contract in src/commands/server.ts:
 *  - the flag resolves through the REAL resolveDevAgentGate (dev agent → live,
 *    fleet → dark; explicit enabled:false force-darks a dev agent);
 *  - LIVE: WriteAdmission is constructed with the REAL registry builder
 *    (buildWriteDomainRegistry — the map the server wires), boot-warmed from a
 *    REAL LocalSessionOwnershipStore on disk, one-way-attached to a REAL
 *    StateManager BEFORE routes are wired, and GET /write-admission serves 200
 *    through a REAL HTTP server;
 *  - the §9.14 double latch holds at the PRODUCTION constant: config
 *    dryRun:false alone does NOT grant refusal authority (mode stays dry-run
 *    while WRITE_SURFACE_INVENTORY_COMPLETE is false);
 *  - DARK: the layer is never constructed — the route 503s and StateManager
 *    keeps the legacy blanket guard (zero presence);
 *  - the guard-posture row (GUARD_MANIFEST 'writeAdmission') is present on a
 *    REAL GET /guards over real disk config;
 *  - burst-invariant: a refusal storm raises ≤1 attention item (§6).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import { WriteAdmission, WriteRefusedError } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry, sessionBuildContextKeyFor } from '../../src/core/WriteDomainRegistry.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';
import { GUARD_MANIFEST } from '../../src/monitoring/guardManifest.js';

const SELF = 'm_self';
const PEER = 'm_peer';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

let dirs: string[] = [];
let servers: TestServer[] = [];
let admissions: WriteAdmission[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
  for (const wa of admissions) wa.stop();
  admissions = [];
  for (const d of dirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/write-admission-lifecycle.test.ts' }); } catch { /* ignore */ }
  }
  dirs = [];
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'write-admission-e2e-'));
  dirs.push(d);
  return d;
}

type E2EConfig = {
  developmentAgent?: boolean;
  multiMachine?: { writeAdmission?: { enabled?: boolean; dryRun?: boolean; refusalAggregateThreshold?: number } };
};

/**
 * The production init path, condensed from src/commands/server.ts: gate →
 * construct (registry + ownership boot-warm + attention hook + log dir) →
 * ONE-WAY attach to StateManager → routes wired AFTER the attach.
 * `inventoryComplete` is the documented TEST SEAM (production never passes it;
 * the compiled WRITE_SURFACE_INVENTORY_COMPLETE governs).
 */
function productionInit(
  config: E2EConfig,
  state: StateManager,
  stateDir: string,
  opts: {
    ownershipStore?: LocalSessionOwnershipStore;
    raiseAttention?: (item: { id: string; title: string; body: string }) => void;
    inventoryComplete?: boolean;
  } = {},
): WriteAdmission | null {
  if (!resolveDevAgentGate(config.multiMachine?.writeAdmission?.enabled, config)) return null;
  const waCfg = config.multiMachine?.writeAdmission;
  const wa = new WriteAdmission(
    {
      thisMachineId: SELF,
      isReadOnly: () => state.readOnly,
      isPoolActive: () => state.sessionPoolActive,
      registry: buildWriteDomainRegistry({ machineId: SELF }),
      dryRun: waCfg?.dryRun ?? true,
      refusalAggregateThreshold: waCfg?.refusalAggregateThreshold ?? 5,
      raiseAttention: opts.raiseAttention,
      logDir: path.join(stateDir, 'logs'),
      disableTimers: true, // test seam: synchronous log visibility, no dangling timers
      ...(opts.inventoryComplete !== undefined ? { inventoryComplete: opts.inventoryComplete } : {}),
    },
    opts.ownershipStore ?? null,
  );
  state.attachWriteAdmission(wa); // one-way, BEFORE routes are wired (§3.2)
  admissions.push(wa);
  return wa;
}

function appWith(stateDir: string, wa: WriteAdmission | null): express.Express {
  const ctx = {
    config: { authToken: '', stateDir, projectDir: path.dirname(stateDir), port: 0 },
    sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => [] },
    startTime: new Date(),
    writeAdmission: wa,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('standby-write reconciliation — E2E lifecycle (feature is alive)', () => {
  it('DEV AGENT (gate live): constructed by the production path, boot-warmed from the REAL on-disk ownership store, route serves 200', async () => {
    const stateDir = path.join(tmp(), '.instar');
    const ownershipDir = path.join(stateDir, 'ownership', 'local');
    fs.mkdirSync(ownershipDir, { recursive: true });
    // A REAL custody record on disk — the Laptop-owns-topic F9 shape.
    fs.writeFileSync(path.join(ownershipDir, '30193.json'), JSON.stringify({
      sessionKey: '30193', ownerMachineId: SELF, ownershipEpoch: 3, status: 'active',
      nonce: 'n1', timestamp: 1, updatedAt: new Date(1).toISOString(),
    }));
    const state = new StateManager(stateDir);
    const wa = productionInit({ developmentAgent: true }, state, stateDir, {
      ownershipStore: new LocalSessionOwnershipStore({ dir: ownershipDir }),
    });
    expect(wa).not.toBeNull();
    expect(state.writeAdmission).toBe(wa); // the attach is wired, not a no-op
    expect(wa!.status().ownershipIndex.entries).toBe(1); // boot-warm saw the real disk

    const server = await listen(appWith(stateDir, wa));
    servers.push(server);
    const res = await fetch(`${server.url}/write-admission`);
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; mode: string; dryRun: boolean };
    expect(body.enabled).toBe(true);
    expect(body.dryRun).toBe(true); // FD-7: dry-run FIRST even on dev
    expect(body.mode).toBe('dry-run');
  });

  it('the §9.14 DOUBLE LATCH holds at the production constant: config dryRun:false alone grants NO refusal authority', () => {
    const stateDir = path.join(tmp(), '.instar');
    const state = new StateManager(stateDir);
    // No inventoryComplete override — the compiled constant (false) governs.
    const wa = productionInit(
      { developmentAgent: true, multiMachine: { writeAdmission: { dryRun: false } } },
      state, stateDir,
    );
    expect(wa!.mode()).toBe('dry-run');
    expect(wa!.isLive).toBe(false);
    // And the store seam proves it end-to-end: a read-only standby still gets
    // the LEGACY blanket verdict (not a typed refusal) — zero authority.
    state.setReadOnly(true);
    expect(() => state.set('unclassified-key', { a: 1 })).toThrow(/StateManager is read-only/);
    try {
      state.set('unclassified-key', { a: 1 });
    } catch (err) {
      expect(err).not.toBeInstanceOf(WriteRefusedError);
    }
  });

  it('FLEET (gate dark): never constructed — route 503s, StateManager keeps the legacy blanket, zero presence', async () => {
    const stateDir = path.join(tmp(), '.instar');
    const state = new StateManager(stateDir);
    const wa = productionInit({}, state, stateDir);
    expect(wa).toBeNull();
    expect(state.writeAdmission).toBeNull();

    const server = await listen(appWith(stateDir, null));
    servers.push(server);
    const res = await fetch(`${server.url}/write-admission`);
    expect(res.status).toBe(503);
    // Zero presence: no admission log dir either.
    expect(fs.existsSync(path.join(stateDir, 'logs', 'write-admission.jsonl'))).toBe(false);
  });

  it('explicit enabled:false force-darks even a dev agent (the gate contract)', () => {
    const stateDir = path.join(tmp(), '.instar');
    const state = new StateManager(stateDir);
    const wa = productionInit(
      { developmentAgent: true, multiMachine: { writeAdmission: { enabled: false } } },
      state, stateDir,
    );
    expect(wa).toBeNull();
  });

  it('the F9 fix is alive end-to-end: with a live layer, the per-machine build-context kv write is ADMITTED on a read-only standby and the refusal log captures divergences', () => {
    const stateDir = path.join(tmp(), '.instar');
    const state = new StateManager(stateDir);
    const wa = productionInit(
      { developmentAgent: true, multiMachine: { writeAdmission: { dryRun: false } } },
      state, stateDir,
      { inventoryComplete: true }, // documented test seam — proves the wave-2 live behavior
    )!;
    state.setReadOnly(true); // the F9 shape: standby lease, owned pool topics
    const key = sessionBuildContextKeyFor(SELF);
    expect(() => state.set(key, { session: 'ctx' })).not.toThrow(); // the 2026-07-02 stderr line, fixed
    expect(state.get(key)).toEqual({ session: 'ctx' });
    // A cluster-shared write on the same standby stays refused — typed now.
    expect(() => state.set('unclassified-cluster-key', { a: 1 })).toThrow(WriteRefusedError);
    wa.flushLog();
    const log = fs.readFileSync(path.join(stateDir, 'logs', 'write-admission.jsonl'), 'utf-8');
    expect(log).toContain('"verdict":"refused"');
    expect(log).toContain('"code":"lease-required"');
  });

  it('BURST INVARIANT (§6): a refusal storm raises exactly ONE deduped attention item — never a flood', () => {
    const stateDir = path.join(tmp(), '.instar');
    const state = new StateManager(stateDir);
    const raised: Array<{ id: string }> = [];
    const wa = productionInit(
      { developmentAgent: true, multiMachine: { writeAdmission: { dryRun: false, refusalAggregateThreshold: 5 } } },
      state, stateDir,
      { inventoryComplete: true, raiseAttention: (i) => raised.push(i) },
    )!;
    state.setReadOnly(true);
    for (let i = 0; i < 40; i++) {
      try { state.set('storm-key', { i }); } catch { /* refused — the storm */ }
    }
    expect(wa.status().domains.find((d) => d.domain === 'cluster-shared')!.refused).toBe(40);
    expect(raised).toHaveLength(1); // ≤1 — the 2026-05-22 flood lesson, structural
  });
});

describe('guard posture row (§3.5 — the manifest entry cannot be forgotten)', () => {
  it('GUARD_MANIFEST carries the writeAdmission entry with the spec-named fields', () => {
    const entry = GUARD_MANIFEST.find((e) => e.key === 'writeAdmission');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('config');
    expect(entry!.configPath).toBe('multiMachine.writeAdmission.enabled');
    expect(entry!.dryRunConfigPath).toBe('multiMachine.writeAdmission.dryRun');
    expect(entry!.process).toBe('server');
    // §3.5: loadBearing stays FALSE while the legacy blanket guard remains the
    // enforcing layer (re-reviewed at fleet graduation).
    expect(entry!.loadBearing).toBe(false);
  });

  it('GET /guards over REAL disk config serves the writeAdmission posture row', async () => {
    const projectDir = tmp();
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ multiMachine: { writeAdmission: { dryRun: true } } }),
    );
    const server = await listen(appWith(stateDir, null));
    servers.push(server);
    const res = await fetch(`${server.url}/guards`);
    expect(res.status).toBe(200);
    const body = await res.json() as { guards: Array<{ key: string; posture?: string; classification?: string }> };
    const row = body.guards.find((g) => g.key === 'writeAdmission');
    expect(row).toBeDefined(); // the posture row cannot be forgotten (§3.5)
  });
});
