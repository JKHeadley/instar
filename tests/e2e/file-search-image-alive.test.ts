// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E "feature is alive" — GET /api/files/search and GET /api/files/image answer on the
 * production AgentServer boot path (createFileRoutes mounted by AgentServer itself, real
 * auth middleware): 200 with results / a real PNG, not 404/503, and key material stays out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-file-search-image';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('File search and image preview are alive on the production boot path', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-search-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({ privateKey: 'E2E-SEARCH-KEY' }), { mode: 0o600 });
    fs.mkdirSync(path.join(tmpDir, 'docs', 'img'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'img', 'diagram.png'), PNG);
    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/file-search-image-alive.test.ts' });
  });

  it('search answers 200 with the file from an unopened folder, and never the key file', async () => {
    const res = await request(app).get('/api/files/search').query({ q: 'diagram' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { path: string }) => r.path)).toEqual(['docs/img/diagram.png']);
    const key = await request(app).get('/api/files/search').query({ q: 'identity' }).set(auth());
    expect(key.status).toBe(200);
    expect(key.body.results).toEqual([]);
  });

  it('image answers 200 with the PNG and its real type', async () => {
    const res = await request(app).get('/api/files/image').query({ path: 'docs/img/diagram.png' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
