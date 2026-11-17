// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 "feature is alive" test for Secret Drop self-mint hardening
 * (docs/specs/secret-drop-self-mint-hardening.md). Boots the REAL AgentServer (the
 * path server.ts uses, auth middleware included) and checks, on the production
 * pipeline: the keyless route admits this machine's own helper (201) and refuses a
 * rebound Host (403); the key-gated route mints as the agent (no receipt notice line);
 * a keyless mint naming a conversation carries the plain notice; and retrieve marks
 * the keyless drop unverified.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Secret Drop self-mint hardening — alive on the production path', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let port: number;
  const AUTH = 'test-e2e-self-mint';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-mint-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
      secrets: { forceFileKey: true },
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir) });
    await server.start();
    const httpServer = (server as unknown as { server?: { address(): AddressInfo | string | null } }).server;
    const addr = httpServer?.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await server?.stop?.();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/secret-drop-self-mint-hardening-alive.test.ts' });
  });

  async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  }

  it('the keyless route admits this machine\'s helper (201) and refuses a rebound Host (403)', async () => {
    expect(port).toBeGreaterThan(0);
    const ok = await post('/threadline/secrets/request', { label: 'alive', topicId: 77 });
    expect(ok.status).toBe(201);
    const okBody = await ok.json() as { token: string; receiptNotice?: string; notice?: string };
    expect(okBody.receiptNotice).toBe('disabled');
    expect(okBody.notice).toMatch(/restart/i);
    // fetch drops a custom Host header, so send this one with node:http as a rebound page would.
    const reboundStatus = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/threadline/secrets/request', method: 'POST',
        headers: { Host: `attacker.example:${port}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end(JSON.stringify({ label: 'x' }));
    });
    expect(reboundStatus).toBe(403);

    const got = await request(server.getApp()).get('/secrets/pending').set('Authorization', `Bearer ${AUTH}`);
    expect(got.status).toBe(200);
    const row = (got.body.pending as Array<{ token: string; origin: string; topicId?: number }>).find((p) => p.token === okBody.token)!;
    expect(row.origin).toBe('unverified');
    expect(row.topicId).toBeUndefined();
  });

  it('the key-gated route mints as the agent: the request keeps its conversation', async () => {
    const res = await post('/secrets/request', { label: 'mine', topicId: 77 }, { Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(201);
    const body = await res.json() as { token: string; receiptNotice?: string };
    expect(body.receiptNotice).toBeUndefined();
    const got = await request(server.getApp()).get('/secrets/pending').set('Authorization', `Bearer ${AUTH}`);
    const row = (got.body.pending as Array<{ token: string; origin: string; topicId?: number }>).find((p) => p.token === body.token)!;
    expect(row.origin).toBe('verified');
    expect(row.topicId).toBe(77);
  });
});
