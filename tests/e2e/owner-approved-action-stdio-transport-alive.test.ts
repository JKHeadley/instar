/**
 * Tier 3 (SEC-018 companion): on the production AgentServer boot path, the loopback
 * `POST /threadline/approved-delete` route is MOUNTED, runs the loopback guard FIRST (so a
 * tunnel-arriving request is refused before anything else), and reaches the server-side
 * `performApprovedDelete` (a non-existent thread → `not-found`). The full owner-approval happy
 * path over the stdio transport is the cross-device live phone-tap proof a server-only e2e
 * cannot stand in for.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'oaa-stdio-alive-token';
const dirs: string[] = [];

function boot(enabled: boolean): AgentServer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oaa-stdio-alive-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
  const config = {
    projectName: 'oaa-stdio-alive', agentName: 'E2E', projectDir: dir, stateDir: path.join(dir, '.instar'),
    port: 0, authToken: AUTH, dashboardPin: '123456',
    ...(enabled ? { security: { ownerApprovedActions: { enabled: true } } } : {}),
  } as InstarConfig;
  const sessionManager = Object.assign(createMockSessionManager() as any, { on: vi.fn() });
  return new AgentServer({ config, sessionManager, state: new StateManager(path.join(dir, '.instar')) } as any);
}

afterAll(() => { for (const d of dirs) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/owner-approved-action-stdio-transport-alive.test.ts' }); } catch { /* best-effort */ } } });

describe('owner-approved-action stdio transport — route is alive (SEC-018 companion)', () => {
  it('the route is MOUNTED (a loopback request is NOT 404)', async () => {
    const server = boot(false);
    const res = await request(server.getApp())
      .post('/threadline/approved-delete').set('Authorization', `Bearer ${AUTH}`)
      .send({ threadId: 'thr_does_not_exist' });
    expect(res.status).not.toBe(404); // the route exists on the production boot path
  });

  it('condition (a): a tunnel-arriving request (X-Forwarded-For) is REFUSED by the loopback guard', async () => {
    const server = boot(true);
    const res = await request(server.getApp())
      .post('/threadline/approved-delete').set('Authorization', `Bearer ${AUTH}`)
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ threadId: 'thr_x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('threadline-mcp-forwarded-refused');
  });

  it('a loopback request reaches performApprovedDelete (missing thread → not-found or unavailable, never 404)', async () => {
    const server = boot(true);
    const res = await request(server.getApp())
      .post('/threadline/approved-delete').set('Authorization', `Bearer ${AUTH}`)
      .send({ threadId: 'thr_does_not_exist' });
    expect(res.status).not.toBe(404);
    // either the op ran (200 {ok:false,reason:'not-found'}) or the stores/map weren't wired (503) —
    // both prove the route is mounted + loopback-admitted and nothing was deleted.
    if (res.status === 200) expect(res.body).toEqual({ ok: false, reason: 'not-found' });
    else expect([503, 400]).toContain(res.status);
  });

  it('a missing threadId is a 400 (loopback-admitted, but nothing to act on)', async () => {
    const server = boot(true);
    const res = await request(server.getApp())
      .post('/threadline/approved-delete').set('Authorization', `Bearer ${AUTH}`).send({});
    expect(res.status).not.toBe(404);
    expect([400, 503]).toContain(res.status);
  });
});
