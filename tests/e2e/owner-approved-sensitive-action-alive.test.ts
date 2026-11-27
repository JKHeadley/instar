/**
 * Tier 3 (SEC-018, docs/specs/owner-approved-sensitive-action.md): on the production AgentServer
 * boot path, the owner-approval action routes are MOUNTED and dark-safe. With the feature off
 * (default) the routes answer 503 `owner-approved-actions-off` — they exist (not 404) and reveal
 * nothing. With the feature on but no owner phone enrolled, the owner-presence gate refuses — so the
 * gate chain is wired, not a no-op. (The full happy path — a real Face-ID tap approving a real
 * delete — is the cross-device live proof, which a server-only e2e cannot stand in for.)
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

const AUTH = 'oaa-alive-e2e-token';
const dirs: string[] = [];

function boot(enabled: boolean): AgentServer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oaa-alive-e2e-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
  const config = {
    projectName: 'oaa-alive-e2e', agentName: 'E2E', projectDir: dir, stateDir: path.join(dir, '.instar'),
    port: 0, authToken: AUTH, dashboardPin: '123456',
    ...(enabled ? { security: { ownerApprovedActions: { enabled: true } } } : {}),
  } as InstarConfig;
  const sessionManager = Object.assign(createMockSessionManager() as any, { on: vi.fn() });
  return new AgentServer({ config, sessionManager, state: new StateManager(path.join(dir, '.instar')) } as any);
}

afterAll(() => { for (const d of dirs) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/owner-approved-sensitive-action-alive.test.ts' }); } catch { /* best-effort */ } } });

describe('owner-approved sensitive action — feature is alive (SEC-018)', () => {
  it('DARK (default): the pending route is MOUNTED and answers 503 owner-approved-actions-off, not 404', async () => {
    const server = boot(false);
    const res = await request(server.getApp()).get('/mobile/action-approval/pending').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).not.toBe(404); // the route exists on the production boot path
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('owner-approved-actions-off');
  });

  it('DARK: the challenge route is also mounted + dark-safe (503, not 404)', async () => {
    const server = boot(false);
    const res = await request(server.getApp()).post('/mobile/action-approval/challenge')
      .set('Authorization', `Bearer ${AUTH}`).send({ purpose: 'thread-delete', actionKey: 'thr_x' });
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('owner-approved-actions-off');
  });

  it('ENABLED without an owner phone: the owner-presence gate refuses — the chain is wired, nothing applied', async () => {
    const server = boot(true);
    const res = await request(server.getApp()).get('/mobile/action-approval/pending').set('Authorization', `Bearer ${AUTH}`);
    // Past the actionApprovalsOn() check, the shared owner-presence gate refuses (no owner phone /
    // no device signature): 403/503, never 404 (route exists) and never 200 (nothing is revealed).
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(200);
    expect([401, 403, 503]).toContain(res.status);
  });
});
