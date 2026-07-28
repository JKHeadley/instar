// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-2 — POST/DELETE /guards/:key/accept-fallback (G3 §2.4/§5).
 * The REAL route behind the real authMiddleware, on real disk. Covers: the
 * dashboard-PIN gate (Bearer alone rejected), the owner+reason REQUIRED rule,
 * the accepted-fallback clearing the loadBearingGap on /guards, and the
 * DELETE-revoke reopening the gap + surviving a "reboot" (fresh server, same disk).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'accept-fallback-token';
const PIN = '424242';
const LB_KEY = 'multiMachine.sessionPool.inboundQueue.enabled';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

let tmpDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-fallback-'));
  stateDir = path.join(tmpDir, 'project', '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  // inboundQueue absent from config → dark-default off → a load-bearing GAP.
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ scheduler: { enabled: true } }));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/guards-accept-fallback-route.test.ts:afterEach' });
});

function ctxFor(): RouteContext {
  return {
    config: {
      projectName: 'accept-fallback', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH, dashboardPin: PIN, monitoring: {}, sessions: {}, scheduler: {},
    },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    startTime: new Date(),
    guardRegistry: new GuardRegistry(),
    meshSelfId: 'm-self',
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

function guardRow(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return (body.guards as Array<Record<string, unknown>>).find((g) => g.key === LB_KEY);
}

describe('POST/DELETE /guards/:key/accept-fallback (integration)', () => {
  it('a load-bearing dark guard shows loadBearingGap on /guards before any accept', async () => {
    const res = await request(appWith(ctxFor())).get('/guards').set(auth());
    expect(res.status).toBe(200);
    const row = guardRow(res.body)!;
    expect(row.loadBearing).toBe(true);
    expect(row.criticalPath).toBeTruthy();
    expect(row.loadBearingGap).toBe(true);
  });

  it('Bearer alone is REJECTED (403) — a Bearer token cannot accept a safety risk (Know Your Principal)', async () => {
    const res = await request(appWith(ctxFor()))
      .post(`/guards/${encodeURIComponent(LB_KEY)}/accept-fallback`)
      .set(auth())
      .send({ reason: 'ops decision', owner: 'justin' }); // no PIN
    expect(res.status).toBe(403);
    // No record written.
    expect(fs.existsSync(path.join(stateDir, 'state', 'guard-accepted-fallbacks.json'))).toBe(false);
  });

  it('owner is REQUIRED (400 when missing) — the PIN proves a PIN-holder, not a named operator', async () => {
    const res = await request(appWith(ctxFor()))
      .post(`/guards/${encodeURIComponent(LB_KEY)}/accept-fallback`)
      .set(auth())
      .send({ reason: 'ops decision', pin: PIN }); // no owner
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/);
  });

  it('a non-load-bearing key is 404 (accept-fallback applies only to load-bearing guards)', async () => {
    const res = await request(appWith(ctxFor()))
      .post('/guards/monitoring.sessionReaper.enabled/accept-fallback')
      .set(auth())
      .send({ reason: 'x', owner: 'justin', pin: PIN });
    expect(res.status).toBe(404);
  });

  it('a valid PIN + reason + owner records the accept and CLEARS the gap on /guards', async () => {
    const app = appWith(ctxFor());
    const post = await request(app)
      .post(`/guards/${encodeURIComponent(LB_KEY)}/accept-fallback`)
      .set(auth())
      .send({ reason: 'inbound queue graduation deferred deliberately', owner: 'justin', pin: PIN });
    expect(post.status).toBe(200);
    expect(post.body.accepted.owner).toBe('justin');
    expect(typeof post.body.accepted.acceptedAt).toBe('string');

    const guards = await request(app).get('/guards').set(auth());
    const row = guardRow(guards.body)!;
    expect(row.loadBearingAccepted).toBe(true);
    expect(row.acceptedFallbackReason).toBe('inbound queue graduation deferred deliberately');
    expect(row.loadBearingGap).toBeUndefined();
  });

  it('DELETE-revoke reopens the gap AND survives a reboot (fresh server, same disk)', async () => {
    // Accept, then a "reboot" (fresh ctx/app) still sees the accept — durable.
    await request(appWith(ctxFor()))
      .post(`/guards/${encodeURIComponent(LB_KEY)}/accept-fallback`)
      .set(auth()).send({ reason: 'owned', owner: 'justin', pin: PIN });
    const afterReboot = await request(appWith(ctxFor())).get('/guards').set(auth());
    expect(guardRow(afterReboot.body)!.loadBearingAccepted).toBe(true);

    // Revoke → gap reopens; a further reboot confirms the revoke is durable too.
    const del = await request(appWith(ctxFor()))
      .delete(`/guards/${encodeURIComponent(LB_KEY)}/accept-fallback`)
      .set(auth()).send({ pin: PIN });
    expect(del.status).toBe(200);
    const reopened = await request(appWith(ctxFor())).get('/guards').set(auth());
    const row = guardRow(reopened.body)!;
    expect(row.loadBearingAccepted).toBeUndefined();
    expect(row.loadBearingGap).toBe(true);
  });

  it('DELETE with no existing record is 404', async () => {
    const del = await request(appWith(ctxFor()))
      .delete(`/guards/${encodeURIComponent(LB_KEY)}/accept-fallback`)
      .set(auth()).send({ pin: PIN });
    expect(del.status).toBe(404);
  });
});
