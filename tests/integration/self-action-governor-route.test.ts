// safe-fs-allow: test file — tmpdir fixtures only.

/**
 * Tier-2 integration — GET /self-action-governor + the nested-path
 * PATCH /config validator (unified-self-action-backpressure companion §12/§11).
 *
 * Through the REAL routes pipeline (createRoutes behind the real
 * authMiddleware):
 *  - a controller's REAL emit path routes through admit() and the route
 *    reports the live per-class counters LOCK-FREE (no write side effects);
 *  - the projection is scrubbed (no target identities);
 *  - `?scope=pool` answers (single-machine: self-only, dark-peer tolerant);
 *  - PATCH /config: exactly `intelligence.selfActionGovernor` is patchable
 *    under `intelligence` (a sibling intelligence.* key 400s — INT9-1);
 *  - the DISABLE direction (emergencyDisable: true) is dashboard-PIN-gated
 *    (ADV9-4); re-enable is Bearer-OK; the deep merge never clobbers sibling
 *    per-class overrides (the one-level-merge full-block hazard).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import {
  initSelfActionGovernor,
  resetSelfActionGovernorModuleForTest,
  type SelfActionGovernorCore,
} from '../../src/monitoring/selfaction/governor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resetAnchorForTest } from '../../src/monitoring/selfaction/anchor.js';

const AUTH = 'sag-int-token';
const PIN = '424242';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

let tmp: string;
let gov: SelfActionGovernorCore;
let emergencyDisable: boolean;

function makeCtx(): RouteContext {
  return {
    config: {
      projectName: 'sag-int',
      projectDir: tmp,
      stateDir: path.join(tmp, '.instar'),
      port: 0,
      authToken: AUTH,
      dashboardPin: PIN,
      sessions: {},
      scheduler: {},
      intelligence: { selfActionGovernor: {} },
    },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] },
    scheduler: null,
    selfActionGovernor: gov,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(makeCtx()));
  return app;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-route-'));
  fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.instar', 'config.json'),
    JSON.stringify({ intelligence: { selfActionGovernor: { classes: { 'age-kill-backoff': { totalCountCeiling: 90 } } } } }),
  );
  emergencyDisable = false;
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
  gov = initSelfActionGovernor({
    stateDir: path.join(tmp, '.instar'),
    readEmergencyDisable: () => emergencyDisable,
    readClassesConfig: () => undefined,
  });
});

afterEach(() => {
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/self-action-governor-route.test.ts' });
});

describe('GET /self-action-governor', () => {
  it('requires Bearer auth', async () => {
    const app = makeApp();
    await request(app).get('/self-action-governor').expect(401);
    await request(app).get('/self-action-governor').set('Authorization', 'Bearer wrong').expect(403);
  });

  it('reports LIVE per-class counters after a real emit path routes through admit()', async () => {
    const app = makeApp();
    const h = gov.for('age-kill-backoff');
    for (let i = 0; i < 6; i++) h.admitSync({ key: 'session:s1', classId: 'session', keyIsVolatile: false });
    const res = await request(app).get('/self-action-governor').set(auth()).expect(200);
    expect(res.body.initialized).toBe(true);
    expect(res.body.emergencyDisable).toBe(false);
    const row = (res.body.classes as Array<{ controllerId: string; counters: { admits: number; wouldDeny: number }; mode: string }>).find(
      (c) => c.controllerId === 'age-kill-backoff',
    )!;
    expect(row.mode).toBe('observe');
    expect(row.counters.admits).toBe(6);
    expect(row.counters.wouldDeny).toBe(1); // the 6th would-deny (per-target ceiling 5)
  });

  it('is a PURE read: two GETs report identical counters (no write side effects)', async () => {
    const app = makeApp();
    gov.for('promise-beacon-notify').admitSync({ key: 'topic:1', classId: 'topic', keyIsVolatile: false });
    const a = await request(app).get('/self-action-governor').set(auth()).expect(200);
    const b = await request(app).get('/self-action-governor').set(auth()).expect(200);
    expect(b.body.classes).toEqual(a.body.classes);
  });

  it('scrubs target identities from the projection (SEC6)', async () => {
    const app = makeApp();
    gov.for('age-kill-backoff').admitSync({ key: 'session:super-secret-topic-name', classId: 'session', keyIsVolatile: false });
    const res = await request(app).get('/self-action-governor').set(auth()).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-topic-name');
  });

  it('?scope=pool answers on a single-machine agent (self-only, never a 500)', async () => {
    const app = makeApp();
    const res = await request(app).get('/self-action-governor?scope=pool').set(auth()).expect(200);
    expect(res.body.scope).toBe('pool');
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.pool.failed).toEqual([]);
  });
});

describe('PATCH /config — the nested-path validator (INT9-1) + PIN-gated disable (ADV9-4)', () => {
  it('rejects any intelligence.* sibling key (never Bearer-exposes spawnCap)', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/config')
      .set(auth())
      .send({ intelligence: { spawnCap: { maxConcurrent: 9999 } } })
      .expect(400);
    expect(res.body.error).toContain('selfActionGovernor');
  });

  it('accepts a per-class override patch and DEEP-merges (sibling class overrides survive)', async () => {
    const app = makeApp();
    await request(app)
      .patch('/config')
      .set(auth())
      .send({ intelligence: { selfActionGovernor: { classes: { 'proactive-swap-monitor': { windowMs: 1800000 } } } } })
      .expect(200);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.instar', 'config.json'), 'utf-8'));
    // The NEW class override landed…
    expect(cfg.intelligence.selfActionGovernor.classes['proactive-swap-monitor'].windowMs).toBe(1800000);
    // …and the PRE-EXISTING sibling override was NOT clobbered (the
    // one-level-deep-merge full-block hazard the validator exists to close).
    expect(cfg.intelligence.selfActionGovernor.classes['age-kill-backoff'].totalCountCeiling).toBe(90);
  });

  it('the DISABLE direction requires the dashboard PIN — a bare Bearer cannot disarm the flood brake', async () => {
    const app = makeApp();
    const refused = await request(app)
      .patch('/config')
      .set(auth())
      .send({ intelligence: { selfActionGovernor: { emergencyDisable: true } } })
      .expect(403);
    expect(refused.body.error).toContain('PIN');
    // With the PIN: accepted.
    await request(app)
      .patch('/config')
      .set(auth())
      .send({ pin: PIN, intelligence: { selfActionGovernor: { emergencyDisable: true } } })
      .expect(200);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.instar', 'config.json'), 'utf-8'));
    expect(cfg.intelligence.selfActionGovernor.emergencyDisable).toBe(true);
    // The PIN itself never lands in config.
    expect(JSON.stringify(cfg)).not.toContain(PIN);
  });

  it('RE-ENABLE is Bearer-OK (the safe direction needs no PIN)', async () => {
    const app = makeApp();
    await request(app)
      .patch('/config')
      .set(auth())
      .send({ intelligence: { selfActionGovernor: { emergencyDisable: false } } })
      .expect(200);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.instar', 'config.json'), 'utf-8'));
    expect(cfg.intelligence.selfActionGovernor.emergencyDisable).toBe(false);
  });

  it('a wrong PIN on the disable direction is refused with the rate-limited PIN path', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/config')
      .set(auth())
      .send({ pin: '000000', intelligence: { selfActionGovernor: { emergencyDisable: true } } })
      .expect(403);
    expect(res.body.error).toContain('Incorrect PIN');
  });
});
