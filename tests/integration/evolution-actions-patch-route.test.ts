import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/evolution-actions-patch-route.test.ts',
      });
    } catch {
      // Test cleanup only.
    }
  }
});

function makeHarness(): { app: express.Express; evolution: EvolutionManager } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-actions-patch-'));
  tmpDirs.push(stateDir);
  const evolution = new EvolutionManager({ stateDir });
  const ctx = {
    config: { authToken: '', stateDir, projectDir: stateDir, port: 0 },
    evolution,
    classReviewStore: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return { app, evolution };
}

function addAction(evolution: EvolutionManager) {
  return evolution.addAction({
    title: 'Original title',
    description: 'Original description',
    priority: 'medium',
  });
}

describe('PATCH /evolution/actions/:id strict update body', () => {
  it('rejects unsupported fields instead of acknowledging a discarded write', async () => {
    const { app, evolution } = makeHarness();
    const action = addAction(evolution);

    const res = await request(app)
      .patch(`/evolution/actions/${action.id}`)
      .send({ title: 'Corrected title' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'Unsupported field(s): title',
      unsupportedFields: ['title'],
      supportedFields: ['status', 'resolution'],
    });
    const stored = evolution.listActions({}).find((item) => item.id === action.id);
    expect(stored?.title).toBe('Original title');
  });

  it('still applies supported status and resolution updates', async () => {
    const { app, evolution } = makeHarness();
    const action = addAction(evolution);

    const res = await request(app)
      .patch(`/evolution/actions/${action.id}`)
      .send({ status: 'completed', resolution: 'Verified complete' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: action.id, status: 'completed' });
    const stored = evolution.listActions({}).find((item) => item.id === action.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.resolution).toBe('Verified complete');
    expect(stored?.completedAt).toEqual(expect.any(String));
  });

  it('rejects a body with no usable update field', async () => {
    const { app, evolution } = makeHarness();
    const action = addAction(evolution);

    const res = await request(app)
      .patch(`/evolution/actions/${action.id}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Request body must include at least one supported field: status, resolution');
    const stored = evolution.listActions({}).find((item) => item.id === action.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.resolution).toBeUndefined();
  });

  it('keeps the missing-action path as a 404 after validating a usable update', async () => {
    const { app } = makeHarness();

    const res = await request(app)
      .patch('/evolution/actions/ACT-999')
      .send({ status: 'in_progress' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Action not found');
  });

  it('keeps invalid status rejected before any write', async () => {
    const { app, evolution } = makeHarness();
    const action = addAction(evolution);

    const res = await request(app)
      .patch(`/evolution/actions/${action.id}`)
      .send({ status: 'implemented' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('"status" must be one of: pending, in_progress, completed, cancelled');
    const stored = evolution.listActions({}).find((item) => item.id === action.id);
    expect(stored?.status).toBe('pending');
  });
});
