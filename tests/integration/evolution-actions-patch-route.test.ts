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
      supportedFields: ['status', 'resolution', 'autoExpiryHold'],
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
    expect(res.body.error).toBe('Request body must include at least one supported field: status, resolution, autoExpiryHold');
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

describe('CMT-1132 action hold and archive routes', () => {
  it('sets, refuses and clears a hold', async () => {
    const { app, evolution } = makeHarness();
    const action = addAction(evolution);
    await request(app).patch(`/evolution/actions/${action.id}`).send({ autoExpiryHold: { reason: ' ' } }).expect(400);
    await request(app).patch(`/evolution/actions/${action.id}`).send({ autoExpiryHold: { reason: 'review 10-30' } }).expect(200);
    expect(evolution.listActions({})[0].autoExpiryHold).toMatchObject({ reason: 'review 10-30' });
    await request(app).patch(`/evolution/actions/${action.id}`).send({ autoExpiryHold: null }).expect(200);
    expect(evolution.listActions({})[0].autoExpiryHold).toBeUndefined();
  });

  it('lists the archive and restores from it', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-actions-archive-'));
    tmpDirs.push(stateDir);
    const evolution = new EvolutionManager({ stateDir, autoExpiry: { enabled: false, maxAgeDays: 1, dryRun: false } });
    const ctx = { config: { authToken: '', stateDir, projectDir: stateDir, port: 0 }, evolution, classReviewStore: null, startTime: new Date() } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));

    const action = addAction(evolution);
    const queue = path.join(stateDir, 'state', 'evolution', 'action-queue.json');
    const state = JSON.parse(fs.readFileSync(queue, 'utf8'));
    state.actions[0].createdAt = '2026-01-01T00:00:00.000Z';
    fs.writeFileSync(queue, JSON.stringify(state));
    expect(evolution.runActionAutoExpirySweep()).toMatchObject({ expired: 1 });

    const listed = await request(app).get('/evolution/actions/archive').expect(200);
    expect(listed.body.count).toBe(1);
    expect(listed.body.entries[0].action).toMatchObject({ id: action.id, description: 'Original description' });

    await request(app).post('/evolution/actions/ACT-999/restore').expect(404);
    const restored = await request(app).post(`/evolution/actions/${action.id}/restore`).expect(200);
    expect(restored.body.action).toMatchObject({ id: action.id, status: 'pending' });
    expect(evolution.listActions({}).map((item) => item.id)).toEqual([action.id]);
    await request(app).post(`/evolution/actions/${action.id}/restore`).expect(404);
  });
});
