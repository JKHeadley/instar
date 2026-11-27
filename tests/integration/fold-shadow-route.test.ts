/**
 * Integration — GET /context-budget/fold-shadow through the real AgentServer
 * (context-budget-layered-summaries §16 Phase 2 exit record). Dev-gated: on a
 * development agent it answers 200 with the summary read from the real log;
 * on the fleet (no developmentAgent) 503; an explicit shadow:false turns it off.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { appendShadowFold } from '../../src/monitoring/foldShadowLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/fold-shadow-route.test.ts' }); });
const TOKEN = 'agent-token-for-test';

function app(extra: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-shadow-route-')); dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'fs', authToken: TOKEN }));
  const config = {
    projectName: 'fs', projectDir: dir, stateDir, port: 0, authToken: TOKEN, requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [] },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, ...extra,
  } as unknown as InstarConfig;
  appendShadowFold(stateDir, { at: 1, topicKey: '141133', foldId: 'f1', engine: 'claude-code', outcome: 'graded', reason: null, grades: { retained: 9, retrievable: 0, lost: 1, ungraded: 0, lostRate: 0.1, wouldBe: 'correct-and-reprobe', protectedLost: false } });
  appendShadowFold(stateDir, { at: 2, topicKey: '141133', foldId: null, engine: 'claude-code', outcome: 'skipped', reason: 'not-sampled' });
  const server = new AgentServer({ config, state: new StateManager(stateDir), sessionManager: { listRunningSessions: () => [], getSession: () => null } as never });
  return server.getApp();
}

describe('GET /context-budget/fold-shadow', () => {
  it('on a development agent: 200 with the summary and the recent rows, counts only', async () => {
    const r = await request(app({ developmentAgent: true })).get('/context-budget/fold-shadow').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ graded: 1, exit: { needed: 40, reached: false }, lostRate: 0.1, reasons: { 'not-sampled': 1 } });
    expect(r.body.recent).toHaveLength(2);
  });
  it('on the fleet, or with shadow:false: 503 naming the switch', async () => {
    const fleet = await request(app({})).get('/context-budget/fold-shadow').set('Authorization', `Bearer ${TOKEN}`);
    expect(fleet.status).toBe(503);
    expect(fleet.body.enableWith).toBe('contextBudget.fold.shadow');
    const off = await request(app({ developmentAgent: true, contextBudget: { fold: { shadow: false } } })).get('/context-budget/fold-shadow').set('Authorization', `Bearer ${TOKEN}`);
    expect(off.status).toBe(503);
  });
  it('needs the bearer token', async () => {
    expect((await request(app({ developmentAgent: true })).get('/context-budget/fold-shadow')).status).toBe(401);
  });
});
