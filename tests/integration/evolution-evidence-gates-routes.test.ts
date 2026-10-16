import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/evolution-evidence-gates-routes.test.ts',
    });
  }
});

function makeHarness(): { app: express.Express; evolution: EvolutionManager; projectDir: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-evidence-routes-'));
  tmpDirs.push(projectDir);
  SafeGitExecutor.execSync(['init'], { cwd: projectDir, stdio: 'ignore', operation: 'tests/integration/evolution-evidence-gates-routes.test.ts:init' });
  SafeGitExecutor.execSync(['config', 'user.email', 'test@example.com'], { cwd: projectDir, operation: 'tests/integration/evolution-evidence-gates-routes.test.ts:config-email' });
  SafeGitExecutor.execSync(['config', 'user.name', 'Test'], { cwd: projectDir, operation: 'tests/integration/evolution-evidence-gates-routes.test.ts:config-name' });
  fs.writeFileSync(path.join(projectDir, 'artifact.txt'), 'implemented');
  SafeGitExecutor.execSync(['add', 'artifact.txt'], { cwd: projectDir, operation: 'tests/integration/evolution-evidence-gates-routes.test.ts:add' });
  SafeGitExecutor.execSync(['commit', '-m', 'seed'], { cwd: projectDir, stdio: 'ignore', operation: 'tests/integration/evolution-evidence-gates-routes.test.ts:commit' });

  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const evolution = new EvolutionManager({ stateDir });
  const ctx = {
    config: { authToken: '', stateDir, projectDir, port: 0 },
    evolution,
    classReviewStore: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return { app, evolution, projectDir };
}

describe('evolution evidence gates routes', () => {
  it('PATCH /evolution/learnings/:id/apply returns 422 without required consumer evidence', async () => {
    const { app, evolution } = makeHarness();
    const learning = evolution.addLearning({
      title: 'Guard prevents write',
      category: 'workflow',
      description: 'The guard prevents writes.',
      source: { discoveredAt: '2026-09-06T00:00:00.000Z' },
    });

    const res = await request(app)
      .patch(`/evolution/learnings/${learning.id}/apply`)
      .send({ appliedTo: 'EVO-009' });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('consumerEvidence');
  });

  it('POST /evolution/learnings/:id/supersede reopens an applied learning', async () => {
    const { app, evolution } = makeHarness();
    const learning = evolution.addLearning({
      title: 'Plain operational note',
      category: 'workflow',
      description: 'Recorded for future review.',
      source: { discoveredAt: '2026-09-06T00:00:00.000Z' },
    });
    evolution.markLearningApplied(learning.id, 'EVO-013');

    const res = await request(app)
      .post(`/evolution/learnings/${learning.id}/supersede`)
      .send({ supersededBy: 'LRN-999', reason: 'new evidence' });

    expect(res.status).toBe(200);
    const stored = evolution.listLearnings({}).find((item) => item.id === learning.id)!;
    expect(stored.applied).toBe(false);
    expect(stored.supersededBy).toBe('LRN-999');
  });

  it('PATCH /evolution/proposals/:id requires committed implementation evidence', async () => {
    const { app, evolution } = makeHarness();
    const proposal = evolution.addProposal({
      title: 'Implement a thing',
      source: 'test',
      description: 'Do it',
      type: 'workflow',
    });

    const refused = await request(app)
      .patch(`/evolution/proposals/${proposal.id}`)
      .send({ status: 'implemented', resolution: 'done' });
    expect(refused.status).toBe(422);

    const missingPath = await request(app)
      .patch(`/evolution/proposals/${proposal.id}`)
      .send({
        status: 'implemented',
        resolution: 'done',
        implementationEvidence: [{ ref: 'HEAD', path: 'missing.txt' }],
      });
    expect(missingPath.status).toBe(422);

    const accepted = await request(app)
      .patch(`/evolution/proposals/${proposal.id}`)
      .send({
        status: 'implemented',
        resolution: 'done',
        implementationEvidence: [{ ref: 'HEAD', path: 'artifact.txt' }],
      });

    expect(accepted.status).toBe(200);
    expect(evolution.listProposals({})[0]?.implementationEvidence?.[0]?.path).toBe('artifact.txt');
  });

  it('PATCH /evolution/proposals/:id refuses implemented status when resolution says work is not implemented', async () => {
    const { app, evolution } = makeHarness();
    const proposal = evolution.addProposal({
      title: 'Contradictory completion',
      source: 'test',
      description: 'Do it',
      type: 'workflow',
    });

    const res = await request(app)
      .patch(`/evolution/proposals/${proposal.id}`)
      .send({
        status: 'implemented',
        resolution: 'NOT implemented: still blocked on review',
        implementationEvidence: [{ ref: 'HEAD', path: 'artifact.txt' }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('contradicts');
  });

  it('POST /evolution/learnings requires HTTP evidence to carry a discriminating preflight', async () => {
    const { app } = makeHarness();

    const missingPreflight = await request(app)
      .post('/evolution/learnings')
      .send({
        title: 'HTTP route evidence',
        category: 'workflow',
        description: 'A route result was used as evidence.',
        source: { discoveredAt: '2026-09-06T00:00:00.000Z' },
        evidenceLines: [{
          instrument: 'GET /evolution/actions/ACT-299',
          observed: '404',
          disconfirmation: '200',
          denominator: 'one route probe',
        }],
      });
    expect(missingPreflight.status).toBe(422);
    expect(missingPreflight.body.error).toContain('httpPreflight');

    const accepted = await request(app)
      .post('/evolution/learnings')
      .send({
        title: 'HTTP route evidence with preflight',
        category: 'workflow',
        description: 'A route result was used as evidence.',
        source: { discoveredAt: '2026-09-06T00:00:00.000Z' },
        evidenceLines: [{
          instrument: 'GET /evolution/actions/ACT-299',
          observed: '404',
          disconfirmation: '200',
          denominator: 'one route probe',
          httpPreflight: {
            present: '/known-present',
            absent: '/known-absent',
            presentStatus: 200,
            absentStatus: 404,
          },
        }],
      });
    expect(accepted.status).toBe(201);
  });
});
