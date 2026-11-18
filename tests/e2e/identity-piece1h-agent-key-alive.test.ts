// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" test for docs/specs/identity-security-piece1h-no-token-refusal.md.
 *
 * Boots the REAL AgentServer. With a key the secret store did not load, a protected route answers
 * 503 agent-credential-unavailable (not a crash) and /health still answers; the server's own
 * re-read watcher is running, and the moment it loads the key the same route accepts that key with
 * no restart. With no key at all, the route is served as today.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir = '';
let srv: http.Server | null = null;
let server: AgentServer | null = null;

async function boot(authToken: unknown) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-key-e2e-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const config = {
    projectName: 'e2e-agent-key', projectDir: tmpDir, stateDir, port: 0, authToken, dashboardPin: '864209',
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: tmpDir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as unknown as InstarConfig;
  server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as any, state: new StateManager(stateDir) } as any);
  srv = await new Promise<http.Server>((resolve) => { const s = server!.getApp().listen(0, '127.0.0.1', () => resolve(s)); });
  (server as any).startAgentKeyHealth();
}

afterEach(async () => {
  (server as any)?.agentKeyHealth?.stop();
  if (srv) await new Promise<void>((r) => srv!.close(() => r()));
  srv = null; server = null;
  if (tmpDir) SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/identity-piece1h-agent-key-alive.test.ts:cleanup' });
});

describe('agent API key — E2E lifecycle (feature is alive)', () => {
  it('an unreadable key: protected route 503, /health answers, the watcher loads the key and the route accepts it', async () => {
    await boot({ secret: true });
    const refused = await request(srv!).get('/status').set('Authorization', 'Bearer anything');
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe('agent-credential-unavailable');
    expect((await request(srv!).get('/health')).status).toBe(200);

    const watcher = (server as any).agentKeyHealth;
    expect(watcher).toBeTruthy();
    expect(watcher.waiting).toBe(true);
    // The store comes back: the watcher's re-read returns the real key (the real merge reads a store
    // this temp agent does not have, so the read is stubbed at that one seam).
    watcher.deps.reload = () => 'loaded-key';
    await watcher.tick();
    const ok = await request(srv!).get('/status').set('Authorization', 'Bearer loaded-key').set('X-Instar-AgentId', 'e2e-agent-key');
    expect(ok.status).not.toBe(503);
    expect(ok.status).not.toBe(403);
  });

  it('no key: the protected route is served as today and the watcher stays idle', async () => {
    await boot(undefined);
    const res = await request(srv!).get('/status');
    expect(res.status).not.toBe(503);
    expect(res.status).not.toBe(401);
    expect((server as any).agentKeyHealth.waiting).toBe(false);
  });
});
