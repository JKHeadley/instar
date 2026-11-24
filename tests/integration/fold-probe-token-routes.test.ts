/**
 * Integration — the shadow answerer's fold-probe token against the FULL HTTP
 * pipeline (context-budget-layered-summaries §10 "Shadow mode"; Phase 2 P2-3b).
 *
 * A real MemoryPrivacy issues the token; the real AgentServer middleware and
 * memory-session guard decide. The layers are off in this server, so a request
 * that passes the guard reaches the chunk handler and answers 503 (layers off),
 * while a refused one answers 403 from the guard: the difference is the proof
 * the token reaches its own topic's chunk lookups and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('fold-probe token × the real HTTP pipeline', () => {
  let dir: string;
  let app: Parameters<typeof request>[0];
  let probe: string;
  let privacy: MemoryPrivacy;
  const agentToken = 'agent-token-for-test';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-probe-routes-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'fp', authToken: agentToken }));
    const config = {
      projectName: 'fp', projectDir: dir, stateDir, port: 0, authToken: agentToken, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    privacy = new MemoryPrivacy({ stateDir, instarRoot: dir, agentId: 'fp', config: () => ({}), users: () => [], reachable: () => ({}) });
    probe = privacy.issueFoldProbeToken('fold-probe-fold-1', '141133');
    const server = new AgentServer({
      config, state: new StateManager(stateDir), memoryPrivacy: privacy,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, memoryAudienceKind: () => 'open' } as never,
    });
    app = server.getApp();
  });
  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/fold-probe-token-routes.test.ts' }));

  const get = (token: string, route: string) => request(app).get(route).set('Authorization', `Bearer ${token}`);

  it('passes the guard to its own topic\'s chunk handlers (503 here: the layers are off)', async () => {
    expect((await get(probe, '/topic/141133/chunks')).status).toBe(503);
    expect((await get(probe, '/topic/141133/chunks/span-1')).status).toBe(503);
  });

  it('is refused another topic\'s chunks and every other route', async () => {
    expect((await get(probe, '/topic/999/chunks')).status).toBe(403);
    expect((await get(probe, '/topic/141133/user-corpus')).status).toBe(403);
    expect((await get(probe, '/topic/search?topic=141133&q=x')).status).toBe(403);
    expect((await get(probe, '/context-budget/sentinel')).status).toBe(403);
    expect((await request(app).post('/telegram/reply/141133').set('Authorization', `Bearer ${probe}`).send({ text: 'hi' })).status).toBe(403);
    expect((await request(app).post('/messaging/preflight').set('Authorization', `Bearer ${probe}`).send({})).status).toBe(403);
  });

  it('the agent token still reaches the chunk routes; a revoked probe token reaches nothing', async () => {
    expect((await get(agentToken, '/topic/141133/chunks')).status).toBe(503);
    privacy.revokeSessionTokens('fold-probe-fold-1');
    expect((await get(probe, '/topic/141133/chunks')).status).toBe(401);
  });
});
