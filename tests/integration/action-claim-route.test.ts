// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Integration (Tier 2) — POST /action-claim/observe over the real HTTP pipeline:
 * flag-gating, server-side classification, idempotent commitment-create (FD3),
 * per-topic cap, and signal-only no-op on a non-claim. Uses a real CommitmentTracker
 * + LiveConfig + supertest.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

let tmpDir: string;
function writeConfig(over: Record<string, unknown>) {
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ port: 0, ...over }));
}
function ctxWith(): { ctx: RouteContext; tracker: CommitmentTracker } {
  const liveConfig = new LiveConfig(tmpDir);
  const tracker = new CommitmentTracker({ stateDir: tmpDir, liveConfig, originMachineId: 'm_owner' });
  const ctx = {
    config: { projectName: 't', projectDir: tmpDir, stateDir: tmpDir, port: 0 } as any,
    liveConfig, commitmentTracker: tracker,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: {} as any, scheduler: null, telegram: null, relationships: null, feedback: null,
    startTime: new Date(),
  } as any;
  return { ctx, tracker };
}
function makeApp(ctx: RouteContext) {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('POST /action-claim/observe (integration)', () => {
  it('no-ops when the feature flag is off (default)', async () => {
    writeConfig({});
    const { ctx } = ctxWith();
    const res = await request(makeApp(ctx)).post('/action-claim/observe').send({ message: "I'll restart the server now.", topicId: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ observed: false, registered: false, reason: 'feature-disabled' });
  });

  it('registers a follow-through commitment on a concrete future-action claim', async () => {
    writeConfig({ messaging: { actionClaim: { enabled: true } } });
    const { ctx, tracker } = ctxWith();
    const res = await request(makeApp(ctx)).post('/action-claim/observe').send({ message: "I'll restart the server now to apply it.", topicId: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ observed: true, registered: true, verb: 'restart' });
    expect(res.body.commitmentId).toMatch(/^CMT-/);
    expect(tracker.getActive().filter((c) => c.topicId === 7)).toHaveLength(1);
  });

  it('is idempotent — a restated claim returns the SAME commitment (FD3 dedupe)', async () => {
    writeConfig({ messaging: { actionClaim: { enabled: true } } });
    const { ctx, tracker } = ctxWith();
    const app = makeApp(ctx);
    const a = await request(app).post('/action-claim/observe').send({ message: "I'll restart it now.", topicId: 7 });
    const b = await request(app).post('/action-claim/observe').send({ message: "Restarting it now, one sec.", topicId: 7 });
    expect(b.body.commitmentId).toBe(a.body.commitmentId);
    expect(tracker.getActive().filter((c) => c.topicId === 7)).toHaveLength(1);
  });

  it('no-ops (no commitment) on a non-claim message', async () => {
    writeConfig({ messaging: { actionClaim: { enabled: true } } });
    const { ctx, tracker } = ctxWith();
    const res = await request(makeApp(ctx)).post('/action-claim/observe').send({ message: "I'll take a look and let you know.", topicId: 7 });
    expect(res.body).toMatchObject({ observed: true, registered: false, reason: 'no-action-claim' });
    expect(tracker.getActive()).toHaveLength(0);
  });

  it('enforces the per-topic cap', async () => {
    writeConfig({ messaging: { actionClaim: { enabled: true, perTopicCap: 2 } } });
    const { ctx } = ctxWith();
    const app = makeApp(ctx);
    await request(app).post('/action-claim/observe').send({ message: "I'll restart it now.", topicId: 7 });
    await request(app).post('/action-claim/observe').send({ message: "I'll push the change now.", topicId: 7 });
    const third = await request(app).post('/action-claim/observe').send({ message: "I'll deploy it now.", topicId: 7 });
    expect(third.body).toMatchObject({ observed: true, registered: false, reason: 'per-topic-cap' });
  });

  it('400s on bad input', async () => {
    writeConfig({ messaging: { actionClaim: { enabled: true } } });
    const { ctx } = ctxWith();
    const res = await request(makeApp(ctx)).post('/action-claim/observe').send({ message: 'x' });
    expect(res.status).toBe(400);
  });
});
