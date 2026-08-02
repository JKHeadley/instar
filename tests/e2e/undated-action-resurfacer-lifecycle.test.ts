/** Production-path proof: AgentServer constructs the resurfacer with the real
 * EvolutionManager action reader and exposes its readable cadence state. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('UndatedActionResurfacer production lifecycle', () => {
  let dir: string;
  let server: AgentServer;
  const raisedAttentionIds: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undated-e2e-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const evolution = new EvolutionManager({ stateDir });
    evolution.addAction({
      title: 'Previously invisible action', description: 'No due date exists on this stock row', priority: 'critical',
      followThroughOptOutReason: 'Legacy stock row retained for bounded explicit review.',
    });
    const telegram = { createAttentionItem: async (item: { id: string }) => { raisedAttentionIds.push(item.id); return item; } };
    const config: InstarConfig = {
      projectName: 'undated-e2e', projectDir: dir, stateDir, port: 0,
      developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      evolutionActions: { undatedResurfacer: { dryRun: false, runIntervalMs: 60_000 } },
    };
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), evolution, telegram: telegram as any });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/undated-action-resurfacer-lifecycle.test.ts' });
  });

  it('is constructed, reads the real action store, and delegates to the production Attention seam', async () => {
    const res = await request(server.getApp()).get('/evolution/actions/undated-resurfacer');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.operational).toBe(true);
    expect(res.body.stateAuthority.mode).toBe('single-machine');
    expect(res.body.ledgerReadable).toBe(true);
    expect(res.body.totalRuns).toBeGreaterThanOrEqual(1);
    expect(res.body.lastRun.selectedActionId).toBe('ACT-001');
    expect(raisedAttentionIds).toEqual(['resurface:ACT-001:s1:1']);
  });
});
