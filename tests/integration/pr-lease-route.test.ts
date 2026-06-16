// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Integration (Tier 2) — POST /pr-leases/evaluate + GET /pr-leases over the real
 * HTTP pipeline with a real PrHandLease: fail-open paths, own-topic acquire,
 * live-foreign deny, dryRun→allow+wouldDeny, and the GET read surface (derived
 * liveness, holderSessionId redacted). Auth (Bearer) is enforced by the server's
 * global middleware, not in-handler, so it is not exercised at this mounted-router tier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { PrHandLease } from '../../src/core/PrHandLease.js';

let tmpDir: string;
let running: string[];

function writeConfig(over: Record<string, unknown>) {
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ port: 0, ...over }));
}
function ctxWith(withLease: boolean): { ctx: RouteContext; lease: PrHandLease | null } {
  const liveConfig = new LiveConfig(tmpDir);
  const lease = withLease
    ? new PrHandLease({ stateDir: tmpDir, machineId: 'm_test', runningSessionNames: () => running })
    : null;
  const ctx = {
    config: { projectName: 't', projectDir: tmpDir, stateDir: tmpDir, port: 0 } as any,
    liveConfig, prHandLease: lease, commitmentTracker: null,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: {} as any, scheduler: null, telegram: null, relationships: null, feedback: null,
    startTime: new Date(),
  } as any;
  return { ctx, lease };
}
function makeApp(ctx: RouteContext) {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prl-')); running = []; });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('POST /pr-leases/evaluate (integration)', () => {
  it('fails open (allow) when the feature is not wired (prHandLease null)', async () => {
    writeConfig({});
    const { ctx } = ctxWith(false);
    const res = await request(makeApp(ctx)).post('/pr-leases/evaluate')
      .send({ command: 'git push origin foo', cwd: tmpDir, topicId: 1, sessionName: 's1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: 'allow', reason: 'feature-disabled' });
  });

  it('fails open on a malformed request', async () => {
    writeConfig({});
    const { ctx } = ctxWith(true);
    const res = await request(makeApp(ctx)).post('/pr-leases/evaluate').send({ command: 'git push origin foo' });
    expect(res.body).toMatchObject({ decision: 'allow', reason: 'bad-request-failopen' });
  });

  it('fails open (no-branch-key) on a non-push command', async () => {
    writeConfig({});
    const { ctx } = ctxWith(true);
    const res = await request(makeApp(ctx)).post('/pr-leases/evaluate')
      .send({ command: 'git status', cwd: tmpDir, topicId: 1, sessionName: 's1' });
    expect(res.body).toMatchObject({ decision: 'allow', reason: 'no-branch-key' });
  });

  it('own-topic push is allowed and acquires the lease', async () => {
    writeConfig({});
    const { ctx, lease } = ctxWith(true);
    const res = await request(makeApp(ctx)).post('/pr-leases/evaluate')
      .send({ command: 'git push origin foo', cwd: tmpDir, topicId: 100, sessionName: 's100' });
    expect(res.body.decision).toBe('allow');
    expect(lease!.list().find((l) => l.key === 'branch:refs/heads/foo')?.holderTopicId).toBe(100);
  });

  it('a live foreign lease DENIES when dryRun:false', async () => {
    writeConfig({ monitoring: { prHandLease: { dryRun: false } } });
    const { ctx, lease } = ctxWith(true);
    running = ['s100'];
    lease!.acquireOrRenew('branch:refs/heads/foo', { topicId: 100, sessionId: 's100' });
    const res = await request(makeApp(ctx)).post('/pr-leases/evaluate')
      .send({ command: 'git push origin foo', cwd: tmpDir, topicId: 999, sessionName: 's999' });
    expect(res.body).toMatchObject({ decision: 'deny', reason: 'live-foreign-lease' });
    expect(res.body.holder).toMatchObject({ holderTopicId: 100 });
    expect(res.body.holder.holderSessionId).toBeUndefined(); // redacted
  });

  it('the SAME live foreign lease only WOULD-deny under dryRun (default) — never blocks', async () => {
    writeConfig({}); // dryRun defaults true
    const { ctx, lease } = ctxWith(true);
    running = ['s100'];
    lease!.acquireOrRenew('branch:refs/heads/foo', { topicId: 100, sessionId: 's100' });
    const res = await request(makeApp(ctx)).post('/pr-leases/evaluate')
      .send({ command: 'git push origin foo', cwd: tmpDir, topicId: 999, sessionName: 's999' });
    expect(res.body).toMatchObject({ decision: 'allow', wouldDeny: true, wouldReason: 'live-foreign-lease' });
  });
});

describe('GET /pr-leases (integration)', () => {
  it('503 when the feature is not enabled', async () => {
    writeConfig({});
    const { ctx } = ctxWith(false);
    const res = await request(makeApp(ctx)).get('/pr-leases');
    expect(res.status).toBe(503);
  });

  it('lists leases with derived liveness and redacted holderSessionId', async () => {
    writeConfig({});
    const { ctx, lease } = ctxWith(true);
    running = ['s100'];
    lease!.acquireOrRenew('branch:refs/heads/foo', { topicId: 100, sessionId: 's100' });
    const res = await request(makeApp(ctx)).get('/pr-leases');
    expect(res.status).toBe(200);
    const row = res.body.leases.find((l: { key: string }) => l.key === 'branch:refs/heads/foo');
    expect(row.liveness).toBe('live');
    expect(row.holderSessionId).toBeUndefined();
  });
});
