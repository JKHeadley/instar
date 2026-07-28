/**
 * Integration (Tier 2) — the External-Hog sentinel routes over the real HTTP pipeline (CMT-1901):
 * GET /external-hog (status + durable arm state, 503 when dark), POST /external-hog/arm
 * (PIN-gated — a Bearer token cannot arm a real kill), POST /external-hog/disarm (Bearer, the safe
 * direction). Proves the arm→disarm→re-arm epoch lifecycle end-to-end through the routes + the
 * durable marker file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
const PIN = '246813';

function mockSentinel() {
  return {
    status: () => ({
      effectiveState: 'on-dry-run', enabled: true, dryRun: true, markerValid: false,
      samplerDead: false, lastTickAt: 1000, recentOutcomes: [], trackedDeferrals: 0,
    }),
  } as any;
}

function ctxWith(over: Partial<RouteContext> = {}): RouteContext {
  return {
    config: { projectName: 't', projectDir: tmpDir, stateDir: tmpDir, port: 0, dashboardPin: PIN } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: {} as any, scheduler: null, telegram: null, relationships: null, feedback: null,
    startTime: new Date(),
    externalHogSentinel: mockSentinel(),
    ...over,
  } as any;
}
function makeApp(ctx: RouteContext) {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exthog-routes-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/external-hog-routes.test.ts' }); });

describe('GET /external-hog', () => {
  it('503 when the sentinel is not wired (dark)', async () => {
    const res = await request(makeApp(ctxWith({ externalHogSentinel: null }))).get('/external-hog');
    expect(res.status).toBe(503);
  });
  it('200 with status + a disarmed arm block on a fresh install', async () => {
    const res = await request(makeApp(ctxWith())).get('/external-hog');
    expect(res.status).toBe(200);
    expect(res.body.status.effectiveState).toBe('on-dry-run');
    expect(res.body.arm).toMatchObject({ armed: false, armEpoch: null, lastDisarmEpoch: 0 });
  });
});

describe('POST /external-hog/arm — PIN-gated', () => {
  it('403 without a PIN (a Bearer token cannot arm a real kill)', async () => {
    const res = await request(makeApp(ctxWith())).post('/external-hog/arm').send({});
    expect(res.status).toBe(403);
  });
  it('403 with the wrong PIN', async () => {
    const res = await request(makeApp(ctxWith())).post('/external-hog/arm').send({ pin: '000000' });
    expect(res.status).toBe(403);
  });
  it('200 with the correct PIN — arms every allowlist class at armEpoch 1', async () => {
    const res = await request(makeApp(ctxWith())).post('/external-hog/arm').send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, armed: true, armEpoch: 1 });
    expect(res.body.armedClasses).toContain('vscode-exthost');
    // The durable marker file was written.
    expect(fs.existsSync(path.join(tmpDir, 'external-hog-arm.json'))).toBe(true);
  });
});

describe('the arm → disarm → re-arm epoch lifecycle end-to-end', () => {
  it('GET reflects armed after arm; disarm returns to watch-only; re-arm mints a HIGHER epoch', async () => {
    const app = makeApp(ctxWith());
    // Arm.
    await request(app).post('/external-hog/arm').send({ pin: PIN }).expect(200);
    let get = await request(app).get('/external-hog');
    expect(get.body.arm).toMatchObject({ armed: true, armEpoch: 1 });
    expect(get.body.arm.armedClasses).toContain('vscode-exthost');

    // Disarm (Bearer — no PIN needed; the safe direction).
    const dis = await request(app).post('/external-hog/disarm').send({});
    expect(dis.status).toBe(200);
    expect(dis.body).toMatchObject({ ok: true, armed: false });
    get = await request(app).get('/external-hog');
    expect(get.body.arm.armed).toBe(false); // a disarm can't be silently un-done

    // Re-arm → a fresh, strictly-higher epoch (returning to live-kill needs a new PIN arm).
    const rearm = await request(app).post('/external-hog/arm').send({ pin: PIN });
    expect(rearm.body.armEpoch).toBe(2);
    get = await request(app).get('/external-hog');
    expect(get.body.arm).toMatchObject({ armed: true, armEpoch: 2 });
  });
});
