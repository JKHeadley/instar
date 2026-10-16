import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Evolution evidence gates production lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let evolution: EvolutionManager;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-evidence-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    SafeGitExecutor.execSync(['init'], { cwd: tmpDir, stdio: 'ignore', operation: 'tests/e2e/evolution-evidence-gates-lifecycle.test.ts:init' });
    SafeGitExecutor.execSync(['config', 'user.email', 'test@example.com'], { cwd: tmpDir, operation: 'tests/e2e/evolution-evidence-gates-lifecycle.test.ts:config-email' });
    SafeGitExecutor.execSync(['config', 'user.name', 'Test'], { cwd: tmpDir, operation: 'tests/e2e/evolution-evidence-gates-lifecycle.test.ts:config-name' });
    fs.writeFileSync(path.join(tmpDir, 'artifact.txt'), 'implemented');
    SafeGitExecutor.execSync(['add', 'artifact.txt'], { cwd: tmpDir, operation: 'tests/e2e/evolution-evidence-gates-lifecycle.test.ts:add' });
    SafeGitExecutor.execSync(['commit', '-m', 'seed'], { cwd: tmpDir, stdio: 'ignore', operation: 'tests/e2e/evolution-evidence-gates-lifecycle.test.ts:commit' });

    evolution = new EvolutionManager({ stateDir });
    const config: InstarConfig = {
      projectName: 'evo-evidence-e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: 'test-evo-evidence',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    };
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      evolution,
    });
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/evolution-evidence-gates-lifecycle.test.ts',
    });
  });

  const auth = () => ({ Authorization: 'Bearer test-evo-evidence' });

  it('rejects terminal proposal status without committed evidence, then accepts resolving evidence', async () => {
    const proposal = evolution.addProposal({
      title: 'Evidence gated implementation',
      source: 'e2e',
      description: 'Implement it',
      type: 'workflow',
    });

    const missing = await request(app)
      .patch(`/evolution/proposals/${proposal.id}`)
      .set(auth())
      .send({ status: 'implemented', resolution: 'done' });
    expect(missing.status).toBe(422);

    const accepted = await request(app)
      .patch(`/evolution/proposals/${proposal.id}`)
      .set(auth())
      .send({
        status: 'implemented',
        resolution: 'done',
        implementationEvidence: [{ ref: 'HEAD', path: 'artifact.txt' }],
      });
    expect(accepted.status).toBe(200);
  });

  it('requires consumer evidence before applying a behavioral learning', async () => {
    const created = await request(app)
      .post('/evolution/learnings')
      .set(auth())
      .send({
        title: 'Consumer gate prevents false completion',
        category: 'workflow',
        description: 'The gate prevents applied status without consumer evidence.',
        source: { discoveredAt: '2026-09-06T00:00:00.000Z' },
      });
    expect(created.status).toBe(201);

    const applied = await request(app)
      .patch(`/evolution/learnings/${created.body.id}/apply`)
      .set(auth())
      .send({ appliedTo: 'EVO-009' });
    expect(applied.status).toBe(422);
  });
});
