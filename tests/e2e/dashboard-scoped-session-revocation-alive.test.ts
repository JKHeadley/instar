/**
 * E2E (alive) — SEC-044 + SEC-045 revocation surface on the production AgentServer boot path.
 * The single most important check for a feature with API routes: is it actually wired, and does it
 * honor the dark switch? Proves POST /dashboard/session/revoke-all is MOUNTED, dark-404 when the
 * feature is off, and step-up-gated (403, not 404) when on — so the route exists on the real boot
 * path and adds no surface while dark. The full owner-approval happy path is covered by the
 * integration test; the live dashboard proof covers real browsers + WS/SSE streams.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'e2e-master-token-sec044';
const PIN = '864209';

function makeConfig(stateDir: string, enabled: boolean): InstarConfig {
  return {
    projectName: 'dst-revocation-e2e', projectDir: '/tmp/dre', stateDir, port: 4042,
    authToken: AUTH, dashboardPin: PIN,
    security: { dashboardScopedToken: { enabled } },
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: '/tmp/dre', maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as InstarConfig;
}

let project: TempProject;
let mockSM: MockSessionManager;
function app(enabled: boolean) {
  const s = new AgentServer({ config: makeConfig(project.stateDir, enabled), sessionManager: mockSM as any, state: project.state } as any);
  return s.getApp();
}

beforeEach(() => { project = createTempProject(); mockSM = createMockSessionManager(); });
afterEach(() => { project.cleanup(); });

describe('SEC-044/045 revocation surface is alive on the production boot path', () => {
  it('revoke-all is DARK-404 when the feature is off (no surface while dark)', async () => {
    const r = await request(app(false)).post('/dashboard/session/revoke-all').set('Authorization', `Bearer ${AUTH}`);
    expect(r.status).toBe(404);
  });

  it('revoke-all is MOUNTED and step-up-gated when enabled (403, NOT 404)', async () => {
    const a = app(true);
    const unlock = await request(a).post('/dashboard/unlock').send({ pin: PIN });
    const t = unlock.body.token as string;
    const r = await request(a).post('/dashboard/session/revoke-all').set('Authorization', `Bearer ${t}`);
    expect(r.status).not.toBe(404);      // the route exists on the real boot path
    expect(r.status).toBe(403);          // and refuses a plain dst_ without step-up
    expect(r.body.error).toBe('step-up-required');
  });
});
