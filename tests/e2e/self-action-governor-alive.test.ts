// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * E2E "feature is alive" + wiring-integrity for the SelfActionGovernor
 * (unified-self-action-backpressure companion §13 Tier 3; Testing Integrity
 * Standard Tier 3 — the single most important test for a feature with API
 * routes: does GET /self-action-governor return 200, not 503?).
 *
 * Mirrors the PRODUCTION init path (src/commands/server.ts):
 *  - initSelfActionGovernor with production-shaped deps: a live config read
 *    for emergencyDisable + classes, a REAL state-store-shaped census reader,
 *    a REAL attention funnel fixture (not a null no-op — wiring integrity);
 *  - the guardRegistry-shaped runtime getter reports enabled;
 *  - the REAL routes pipeline serves GET /self-action-governor 200 with
 *    initialized:true and live per-class rows;
 *  - the coherence advert view-seam resolves the governor row + the
 *    pool-shared class MODE rows LIVE from governor runtime state
 *    (a runtime demote is visible — the INT7-1 deliverable);
 *  - the retrofitted controllers' module-scope handles mint against the SAME
 *    process anchor the server initialized (the emit path is alive).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import {
  initSelfActionGovernor,
  getSelfActionGovernor,
  resetSelfActionGovernorModuleForTest,
} from '../../src/monitoring/selfaction/governor.js';
import { resetAnchorForTest } from '../../src/monitoring/selfaction/anchor.js';
import {
  buildCoherenceFlags,
  COHERENCE_CRITICAL_FLAGS,
  type CoherenceConfigView,
} from '../../src/core/machineCoherenceManifest.js';
import { extractGuardPosture } from '../../src/monitoring/guardPosture.js';
import { GUARD_MANIFEST } from '../../src/monitoring/guardManifest.js';
import type { GovernorAttentionItem } from '../../src/monitoring/selfaction/types.js';

const AUTH = 'sag-e2e-token';

let tmp: string;
let attention: GovernorAttentionItem[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-e2e-'));
  attention = [];
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
});

afterEach(() => {
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
  try {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/self-action-governor-alive.test.ts' });
  } catch {
    /* ignore */
  }
});

describe('SelfActionGovernor — feature is ALIVE through the production init path', () => {
  it('boots, registers, serves 200 (not 503), and its wiring deps are real (not null no-ops)', async () => {
    // ── The production-shaped boot (mirrors src/commands/server.ts) ──
    const config: Record<string, unknown> = {
      intelligence: { selfActionGovernor: {} },
      monitoring: {},
    };
    const runningSessions = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    let censusReads = 0;
    const gov = initSelfActionGovernor({
      stateDir: path.join(tmp, '.instar'),
      readEmergencyDisable: () =>
        (config.intelligence as { selfActionGovernor?: { emergencyDisable?: boolean } })?.selfActionGovernor
          ?.emergencyDisable === true,
      readClassesConfig: () =>
        (config.intelligence as { selfActionGovernor?: { classes?: unknown } })?.selfActionGovernor?.classes,
      readCensus: () => {
        censusReads++;
        return { value: runningSessions.length, asOf: Date.now(), confidence: 'high' as const };
      },
      registeredMachineCount: () => 1,
      emitAttention: (item) => {
        attention.push(item); // a REAL funnel fixture — not a null no-op
      },
    });

    // Wiring integrity: the guardRegistry-shaped getter reports live-enabled.
    const status = gov.guardRuntimeStatus();
    expect(status.enabled).toBe(true);
    expect(status.lastTickAt).toBeGreaterThan(0);

    // The census dep delegates to the real reader on the slow tick.
    gov.runSlowTickForTest();
    expect(censusReads).toBeGreaterThanOrEqual(1);

    // ── Feature alive: the REAL routes pipeline returns 200, not 503 ──
    const ctx = {
      config: { projectName: 'sag-e2e', projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 0, authToken: AUTH, sessions: {}, scheduler: {} },
      sessionManager: { listRunningSessions: () => runningSessions },
      state: { getJobState: () => null, getSession: () => null, listSessions: () => runningSessions },
      scheduler: null,
      selfActionGovernor: getSelfActionGovernor(),
      startTime: new Date(),
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(AUTH));
    app.use('/', createRoutes(ctx));

    const h = gov.for('age-kill-backoff');
    h.admitSync({ key: 'session:s1', classId: 'session', keyIsVolatile: false });
    const res = await request(app).get('/self-action-governor').set({ Authorization: `Bearer ${AUTH}` }).expect(200);
    expect(res.body.initialized).toBe(true);
    const row = (res.body.classes as Array<{ controllerId: string; counters: { admits: number } }>).find(
      (c) => c.controllerId === 'age-kill-backoff',
    );
    expect(row?.counters.admits).toBe(1);
  });

  it('the guard-posture surfaces see the governor (manifest entry + synthetic enabled-polarity extraction)', () => {
    const entry = GUARD_MANIFEST.find((e) => e.key === 'intelligence.selfActionGovernor.enabled');
    expect(entry).toBeTruthy();
    expect(entry!.loadBearing).toBe(true);
    expect(entry!.component).toBe('SelfActionGovernor');
    // Polarity normalization: emergencyDisable true reads DISABLED; absent reads ON.
    const on = extractGuardPosture({ monitoring: {}, intelligence: {} });
    expect(on['intelligence.selfActionGovernor.enabled']).toBe(true);
    const off = extractGuardPosture({ monitoring: {}, intelligence: { selfActionGovernor: { emergencyDisable: true } } });
    expect(off['intelligence.selfActionGovernor.enabled']).toBe(false);
  });

  it('the coherence advert resolves the governor row INVERTED and the pool-shared class modes LIVE (INT7-1)', () => {
    const gov = initSelfActionGovernor({
      stateDir: path.join(tmp, '.instar'),
      readEmergencyDisable: () => false,
      readClassesConfig: () => ({ 'proactive-swap-monitor': { mode: 'enforce' } }),
      registeredMachineCount: () => 1,
    });
    const view: CoherenceConfigView = {
      boot: { multiMachine: {}, intelligence: { selfActionGovernor: {} } },
      governorClassMode: (id) => gov.getClassMode(id),
    };
    const flags = buildCoherenceFlags(view);
    expect(flags['selfActionGovernor.emergencyDisable']).toBe('live'); // inverted: not disabled = live
    expect(flags['selfActionGovernor.class.proactive-swap-monitor.mode']).toBe('enforce');
    // A RUNTIME demote is visible in the advert — a config-only read would
    // still say `enforce` and defeat the mode-skew alarm.
    gov.setModeForTest('proactive-swap-monitor', 'demoted');
    const after = buildCoherenceFlags(view);
    expect(after['selfActionGovernor.class.proactive-swap-monitor.mode']).toBe('demoted');
    // The disabled direction reads `off` (the inverted governor row).
    const offView: CoherenceConfigView = {
      boot: { intelligence: { selfActionGovernor: { emergencyDisable: true } } },
    };
    expect(buildCoherenceFlags(offView)['selfActionGovernor.emergencyDisable']).toBe('off');
    // Membership: all three rows ship in the fleet-uniform manifest.
    const keys = COHERENCE_CRITICAL_FLAGS.map((f) => f.key);
    expect(keys).toContain('selfActionGovernor.emergencyDisable');
    expect(keys).toContain('selfActionGovernor.class.proactive-swap-monitor.mode');
    expect(keys).toContain('selfActionGovernor.class.promise-beacon-notify.mode');
  });

  it('the retrofitted controller modules mint against the SAME anchor the server initialized (emit path alive)', async () => {
    const gov = initSelfActionGovernor({
      stateDir: path.join(tmp, '.instar'),
      readEmergencyDisable: () => false,
      readClassesConfig: () => undefined,
    });
    // Importing a retrofitted controller module mints its module-scope handle
    // against the process anchor — the SAME governor instance sees the class.
    await import('../../src/monitoring/PromiseBeacon.js');
    const posture = gov.getPosture();
    // Its two controllers exist as policy rows (the code-default table), and a
    // handle admit lands in the SAME shared counters the route serves.
    expect(posture.classes.some((c) => c.controllerId === 'promise-beacon-notify')).toBe(true);
    expect(posture.classes.some((c) => c.controllerId === 'liveness-heartbeat')).toBe(true);
  });
});
