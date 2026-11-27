// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for SEC-118-R1/R2 (closeUnreadBodyOnError).
 *
 * Boots the REAL AgentServer on the production init path and sends a chunked body of an unexpected type with
 * no auth: the auth gate refuses it before any parser reads the body, and the answer says `Connection: close`
 * in its headers. A refusal after a fully read body keeps the connection.
 */
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-close-unread';
const tmpDirs: string[] = [];

function mkConfig(): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-unread-e2e-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: '482913', requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}
const sm = () => ({ listRunningSessions: () => [], getSession: () => null }) as never;

afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/close-unread-body-alive.test.ts' }); });

function post(port: number, opts: { contentType: string; auth?: boolean; finish: boolean; body: string }): Promise<{ status: number; connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/jobs', agent: false,
      headers: { 'Content-Type': opts.contentType, 'Transfer-Encoding': 'chunked', ...(opts.auth ? { Authorization: `Bearer ${AUTH}` } : {}) },
    }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }); });
    req.on('error', reject);
    req.write(opts.body);
    if (opts.finish) req.end();
    else setTimeout(() => req.destroy(), 3000);
  });
}

describe('SEC-118-R2 E2E (close an unread body, alive on the real server)', () => {
  it('an unauthenticated chunked body of an unknown type gets 401 with Connection: close', async () => {
    const { config, stateDir } = mkConfig();
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir) });
    await server.start();
    const raw = http.createServer(server.getApp());
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (raw.address() as AddressInfo).port;
      const refused = await post(port, { contentType: 'application/x-unknown', finish: false, body: 'x'.repeat(4096) });
      expect(refused.status).toBe(401);
      expect(refused.connection).toBe('close');
    } finally { raw.close(); await server.stop(); }
  });
});
