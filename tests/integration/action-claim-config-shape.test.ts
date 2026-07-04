// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Integration (Tier 2) — actionclaim-config-shape-fix regression guard.
 *
 * THE BUG: on a real install `messaging` is an ARRAY of adapter configs, so the
 * dot-path `messaging.actionClaim.enabled` is UNREACHABLE (getNestedValue walks the
 * array → `array['actionClaim']` is undefined → the `false` default). Because this
 * sentinel defaults OFF, that made it structurally UN-ENABLABLE in production. CI
 * never caught it: every prior test used an OBJECT-shaped `messaging`, which no real
 * install uses. These tests pin the real (array) shape + the top-level `actionClaim`
 * home so the feature can actually be turned on, and so the bug can never regress.
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

// A realistic array-shaped `messaging` block (the production shape).
const ARRAY_MESSAGING = [
  { type: 'telegram', enabled: true, config: { botToken: 'x' } },
  { type: 'slack', enabled: true, config: { botToken: 'y', appToken: 'z' } },
];

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acshape-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('actionClaim enablement on real (array-shaped) messaging', () => {
  it('CONTROL: array messaging with NO actionClaim → feature-disabled (reproduces the trap)', async () => {
    writeConfig({ messaging: ARRAY_MESSAGING });
    const { ctx } = ctxWith();
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .send({ message: "I'll restart the server now to apply it.", topicId: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ observed: false, registered: false, reason: 'feature-disabled' });
  });

  it('array messaging + TOP-LEVEL actionClaim.enabled:true → the feature IS enablable', async () => {
    writeConfig({ messaging: ARRAY_MESSAGING, actionClaim: { enabled: true } });
    const { ctx } = ctxWith();
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .send({ message: "I'll restart the server now to apply it.", topicId: 7 });
    expect(res.status).toBe(200);
    // Before the fix this returned {reason:'feature-disabled'} — the un-enablable bug.
    expect(res.body).toMatchObject({ observed: true, registered: true, verb: 'restart' });
    expect(res.body.commitmentId).toMatch(/^CMT-/);
  });

  it('array messaging + top-level actionClaim tuning knobs are honored (perTopicCap)', async () => {
    writeConfig({ messaging: ARRAY_MESSAGING, actionClaim: { enabled: true, perTopicCap: 1 } });
    const { ctx } = ctxWith();
    const app = makeApp(ctx);
    const first = await request(app).post('/action-claim/observe').send({ message: "I'll deploy the build now.", topicId: 42 });
    expect(first.body).toMatchObject({ registered: true });
    // A DIFFERENT claim on the same topic must hit the cap of 1 (proves the knob is read).
    const second = await request(app).post('/action-claim/observe').send({ message: "I'll merge the PR now.", topicId: 42 });
    expect(second.body).toMatchObject({ registered: false, reason: 'per-topic-cap', cap: 1 });
  });

  it('BACK-COMPAT: legacy object-shaped messaging.actionClaim still enables the feature', async () => {
    writeConfig({ messaging: { actionClaim: { enabled: true } } });
    const { ctx } = ctxWith();
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .send({ message: "I'll restart the server now to apply it.", topicId: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ observed: true, registered: true, verb: 'restart' });
  });

  it('an explicit top-level actionClaim.enabled:false wins (operator off-switch is reachable)', async () => {
    writeConfig({ messaging: ARRAY_MESSAGING, actionClaim: { enabled: false } });
    const { ctx } = ctxWith();
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .send({ message: "I'll restart the server now to apply it.", topicId: 7 });
    expect(res.body).toMatchObject({ observed: false, registered: false, reason: 'feature-disabled' });
  });
});
