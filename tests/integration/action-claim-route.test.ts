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
    expect(res.body).toMatchObject({ observed: true, registered: false, reason: 'no-claim' });
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

// ─────────────────────────────────────────────────────────────────────────────
// slack-followthrough-generalization §9.2 — the Slack (minted-id) registration lane
// ─────────────────────────────────────────────────────────────────────────────
import { createConversationBindAuth as mkAuth } from '../../src/core/conversationBindToken.js';

function slackCtx(over: Record<string, unknown> = {}): {
  ctx: RouteContext;
  tracker: CommitmentTracker;
  auth: ReturnType<typeof mkAuth>;
  attention: Array<{ id: string; priority: string }>;
} {
  // developmentAgent:true → the messaging.actionClaim.slack dev-gate resolves LIVE.
  writeConfig({ developmentAgent: true, messaging: { actionClaim: { enabled: true, slack: { dryRun: false } } }, ...over });
  const liveConfig = new LiveConfig(tmpDir);
  const conversationBinder = {
    bind: (id: number) => ({ ok: true as const, boundTuple: { platform: 'slack' as const, channelId: 'C_TEST', threadTs: String(id) } }),
    release: () => {},
  };
  const tracker = new CommitmentTracker({ stateDir: tmpDir, liveConfig, originMachineId: 'm_owner', conversationBinder });
  const auth = mkAuth(tmpDir);
  const attention: Array<{ id: string; priority: string }> = [];
  const ctx = {
    config: { projectName: 't', projectDir: tmpDir, stateDir: tmpDir, port: 0, developmentAgent: true } as any,
    liveConfig, commitmentTracker: tracker,
    conversationBindAuth: auth,
    telegram: { createAttentionItem: (i: any) => { attention.push({ id: i.id, priority: i.priority }); return Promise.resolve(i); } } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: {} as any, scheduler: null, relationships: null, feedback: null,
    startTime: new Date(),
  } as any;
  return { ctx, tracker, auth, attention };
}

describe('POST /action-claim/observe — Slack minted-id lane (integration)', () => {
  const MINTED = -777;

  it('a time-boxed promise on a minted id with a valid token registers + is beacon-armed + bound', async () => {
    const { ctx, tracker, auth } = slackCtx();
    const token = auth.mint('agent-slack-thread', [MINTED]);
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .set('X-Instar-Bind-Token', token)
      .send({ message: "I'll post the check-in note here in about 5 minutes.", topicId: MINTED });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ observed: true, registered: true, lane: 'time', beaconEnabled: true });
    const rows = tracker.getActive().filter((c) => c.topicId === MINTED);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalKey).toMatch(/^timepromise:/);
    expect(rows[0].beaconEnabled).toBe(true);
    expect(rows[0].boundTuple).toBeTruthy(); // durably bound to the minted id
    expect(rows[0].boundBy).toBe('session:agent-slack-thread');
  });

  it('NO bind token → 403 conversation-bind-not-authorized, no row, attention raised', async () => {
    const { ctx, tracker, attention } = slackCtx();
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .send({ message: "I'll post the note here in about 5 minutes.", topicId: MINTED });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('conversation-bind-not-authorized');
    expect(tracker.getActive()).toHaveLength(0);
    expect(attention.some((a) => a.id === `conversation-bind-refused:${MINTED}`)).toBe(true);
  });

  it('FOREIGN minted id (not in the token set) → 403, no row', async () => {
    const { ctx, tracker, auth } = slackCtx();
    const token = auth.mint('agent-slack-thread', [MINTED]);
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .set('X-Instar-Bind-Token', token)
      .send({ message: "I'll post in about 5 minutes.", topicId: -888 });
    expect(res.status).toBe(403);
    expect(tracker.getActive()).toHaveLength(0);
  });

  it('LANE PRECEDENCE: a dual-signal turn ("I\'ll deploy in 10 min") registers ONE actionclaim row, no timepromise row', async () => {
    const { ctx, tracker, auth } = slackCtx();
    const token = auth.mint('s', [MINTED]);
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .set('X-Instar-Bind-Token', token)
      .send({ message: "I'll deploy in 10 min.", topicId: MINTED });
    expect(res.body).toMatchObject({ registered: true, lane: 'action', verb: 'deploy' });
    const rows = tracker.getActive().filter((c) => c.topicId === MINTED);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalKey).toMatch(/^actionclaim:/);
    expect(rows.some((c) => c.externalKey?.startsWith('timepromise:'))).toBe(false);
    // record()'s internal auto-arm still armed the beacon (time marker present)
    expect(rows[0].beaconEnabled).toBe(true);
  });

  it('SHARED CAP counts BOTH lanes (actionclaim: + timepromise:) against one budget', async () => {
    const { ctx, tracker, auth } = slackCtx({ developmentAgent: true, messaging: { actionClaim: { enabled: true, perTopicCap: 2, slack: { dryRun: false } } } });
    const token = auth.mint('s', [MINTED]);
    const app = makeApp(ctx);
    const send = (m: string) => request(app).post('/action-claim/observe').set('X-Instar-Bind-Token', token).send({ message: m, topicId: MINTED });
    await send("I'll restart it now.");                 // actionclaim:restart
    await send("I'll post the note in about 5 minutes."); // timepromise:...
    const third = await send("I'll deploy it now.");     // actionclaim:deploy — over cap
    expect(third.body).toMatchObject({ registered: false, reason: 'per-topic-cap' });
    expect(tracker.getActive().filter((c) => c.topicId === MINTED)).toHaveLength(2);
  });

  it('dryRun → would-register audit line, NO row', async () => {
    const { ctx, tracker } = slackCtx({ developmentAgent: true, messaging: { actionClaim: { enabled: true, slack: { dryRun: true } } } });
    const auth = mkAuth(tmpDir);
    const token = auth.mint('s', [MINTED]);
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .set('X-Instar-Bind-Token', token)
      .send({ message: "I'll post the note in about 5 minutes.", topicId: MINTED });
    expect(res.body).toMatchObject({ registered: false, dryRun: true, wouldRegister: true, lane: 'time' });
    expect(tracker.getActive()).toHaveLength(0);
    const auditPath = path.join(tmpDir, '..', 'logs', 'action-claim-observe.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    expect(fs.readFileSync(auditPath, 'utf8')).toMatch(/"wouldRegister":true/);
  });

  it('slack lane DARK (not a dev agent, no explicit enable) → slack-lane-dark, no row', async () => {
    writeConfig({ messaging: { actionClaim: { enabled: true } } }); // developmentAgent NOT set, no slack block
    const liveConfig = new LiveConfig(tmpDir);
    const tracker = new CommitmentTracker({ stateDir: tmpDir, liveConfig, originMachineId: 'm_owner' });
    const auth = mkAuth(tmpDir);
    const ctx = {
      config: { projectName: 't', projectDir: tmpDir, stateDir: tmpDir, port: 0 } as any,
      liveConfig, commitmentTracker: tracker, conversationBindAuth: auth, telegram: null,
      sessionManager: { listRunningSessions: () => [] } as any,
      state: {} as any, scheduler: null, relationships: null, feedback: null, startTime: new Date(),
    } as any;
    const token = auth.mint('s', [MINTED]);
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .set('X-Instar-Bind-Token', token)
      .send({ message: "I'll post the note in about 5 minutes.", topicId: MINTED });
    expect(res.body).toMatchObject({ observed: true, registered: false, reason: 'slack-lane-dark' });
    expect(tracker.getActive()).toHaveLength(0);
  });

  it('positive (Telegram) id is UNAFFECTED by the slack gate — registers with no token via legacy fail-open', async () => {
    const { ctx, tracker } = slackCtx();
    const res = await request(makeApp(ctx))
      .post('/action-claim/observe')
      .send({ message: "I'll restart the server now.", topicId: 7 });
    expect(res.body).toMatchObject({ observed: true, registered: true, lane: 'action', verb: 'restart' });
    expect(tracker.getActive().filter((c) => c.topicId === 7)).toHaveLength(1);
  });
});
