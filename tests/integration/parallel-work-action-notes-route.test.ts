// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration (Tier 2) — the CMT-810 HTTP pipeline over the REAL routes:
 *  - POST /action-claim/observe writes an action-derived activity note for a topic
 *    on an approval REQUEST and on an action CLAIM, independent of the commitment
 *    lane's outcome (feature disabled / no claim / registered), and honors the
 *    parallelWork.actionNotes kill switch;
 *  - GET /parallel-work/activities surfaces it immediately as focus + tags + lastAction;
 *  - GET /parallel-work/sentinel is 503 when dark and 200 with live counters when
 *    constructed;
 *  - GET /guards grades monitoring.parallelWorkSentinel.enabled from the registered
 *    getter: on-stale before the first tick, on-confirmed after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { TopicActionNoteStore } from '../../src/core/TopicActionNoteStore.js';
import { ParallelActivityIndex } from '../../src/core/ParallelActivityIndex.js';
import { ParallelWorkSentinel } from '../../src/monitoring/ParallelWorkSentinel.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'pw-notes-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
let rootDir: string;
let tmpDir: string; // the agent's stateDir (<root>/.instar) — the guards route resolves config from dirname(stateDir)/.instar

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-notes-route-'));
  tmpDir = path.join(rootDir, '.instar');
  fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'topic-intent'), { recursive: true });
});
afterEach(() => SafeFsExecutor.safeRmSync(rootDir, { recursive: true, force: true, operation: 'tests/integration/parallel-work-action-notes-route.test.ts' }));

function writeConfig(over: Record<string, unknown>) {
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ port: 0, authToken: AUTH, ...over }));
}

function build(opts: { sentinel?: boolean; registry?: GuardRegistry } = {}) {
  const liveConfig = new LiveConfig(tmpDir);
  const tracker = new CommitmentTracker({ stateDir: tmpDir, liveConfig, originMachineId: 'm_owner' });
  const notes = new TopicActionNoteStore({ stateDir: tmpDir });
  const index = new ParallelActivityIndex({ stateDir: tmpDir, actionNotes: notes, getRefs: () => [] });
  const sentinel = opts.sentinel ? new ParallelWorkSentinel({ getActivities: (now) => index.activities(now) }) : null;
  if (sentinel && opts.registry) opts.registry.register('monitoring.parallelWorkSentinel.enabled', () => sentinel.guardStatus());
  const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  const ctx = {
    config: { projectName: 't', projectDir: rootDir, stateDir: tmpDir, port: 0, authToken: AUTH, monitoring: cfg.monitoring ?? {}, parallelWork: cfg.parallelWork },
    liveConfig, commitmentTracker: tracker,
    topicActionNotes: notes, parallelActivityIndex: index, parallelWorkSentinel: sentinel,
    guardRegistry: opts.registry ?? null,
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, relationships: null, feedback: null, startTime: new Date(), meshSelfId: 'm-int',
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return { app, tracker, notes, index, sentinel };
}

describe('CMT-810 — action-derived activity notes over HTTP', () => {
  it('an approval REQUEST writes a note and the activities index shows it immediately (no commitment opened)', async () => {
    writeConfig({ actionClaim: { enabled: true } });
    const { app, tracker } = build();
    const r = await request(app).post('/action-claim/observe').set(auth())
      .send({ message: 'Build is green. May I restart the Mac Studio to clear the kernel leak? ~3 minutes.', topicId: 102965 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ observed: true, registered: false, reason: 'no-claim', activityNote: { kind: 'approval-request', verb: 'restart', deduped: false } });
    expect(tracker.getActive()).toHaveLength(0); // a request is NOT a commitment

    const a = await request(app).get('/parallel-work/activities').set(auth());
    expect(a.status).toBe(200);
    const row = a.body.activities.find((x: { topicId: number }) => x.topicId === 102965);
    expect(row.focus).toBe('Asked the operator to approve: restart — "May I restart the Mac Studio to clear the kernel leak?"');
    expect(row.lastAction).toMatchObject({ kind: 'approval-request', verb: 'restart' });
    expect(row.tags).toEqual(expect.arrayContaining(['restart', 'studio', 'kernel', 'leak']));
    expect(typeof row.updatedAt).toBe('number');
  });

  it('an action CLAIM writes a note AND still registers the follow-through commitment (both lanes intact)', async () => {
    writeConfig({ actionClaim: { enabled: true } });
    const { app, tracker, notes } = build();
    const r = await request(app).post('/action-claim/observe').set(auth()).send({ message: "I'll restart the desk session now.", topicId: 7 });
    expect(r.body).toMatchObject({ registered: true, verb: 'restart', activityNote: { kind: 'action-claim', verb: 'restart' } });
    expect(tracker.getActive().filter((c) => c.topicId === 7)).toHaveLength(1);
    expect(notes.notes(7)[0]).toMatchObject({ kind: 'action-claim', verb: 'restart', source: 'action-claim-observe' });
  });

  it('the note is written even when the action-claim sentinel is DISABLED (awareness does not depend on the commitment lane)', async () => {
    writeConfig({});
    const { app, notes } = build();
    const r = await request(app).post('/action-claim/observe').set(auth()).send({ message: 'Can I reboot the Studio now?', topicId: 61449 });
    expect(r.body).toMatchObject({ observed: false, reason: 'feature-disabled', activityNote: { kind: 'approval-request', verb: 'reboot' } });
    expect(notes.latest(61449)?.verb).toBe('reboot');
  });

  it('honors the kill switch parallelWork.actionNotes.enabled:false (read live) — nothing written', async () => {
    writeConfig({ actionClaim: { enabled: true }, parallelWork: { actionNotes: { enabled: false } } });
    const { app, notes } = build();
    const r = await request(app).post('/action-claim/observe').set(auth()).send({ message: 'May I restart the Studio?', topicId: 5 });
    expect(r.body.activityNote).toBeNull();
    expect(notes.listTopicIds()).toEqual([]);
  });

  it('a benign turn writes nothing (activityNote null) and the topic does not appear', async () => {
    writeConfig({ actionClaim: { enabled: true } });
    const { app } = build();
    const r = await request(app).post('/action-claim/observe').set(auth()).send({ message: "I'll take a look and get back to you.", topicId: 9 });
    expect(r.body).toMatchObject({ reason: 'no-claim', activityNote: null });
    const a = await request(app).get('/parallel-work/activities').set(auth());
    expect(a.body.activities.find((x: { topicId: number }) => x.topicId === 9)).toBeUndefined();
  });

  it('secrets in the matched sentence are scrubbed before the excerpt is stored', async () => {
    writeConfig({ actionClaim: { enabled: true } });
    const { app, notes } = build();
    await request(app).post('/action-claim/observe').set(auth())
      .send({ message: 'May I rotate the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 now?', topicId: 11 });
    const n = notes.latest(11)!;
    expect(n.excerpt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(n.excerpt).toContain('REDACTED');
  });

  it('a repeated identical turn is deduped (one note), and auth is required', async () => {
    writeConfig({ actionClaim: { enabled: true } });
    const { app, notes } = build();
    await request(app).post('/action-claim/observe').set(auth()).send({ message: 'Should I kill the stuck session?', topicId: 3 });
    const second = await request(app).post('/action-claim/observe').set(auth()).send({ message: 'Should I kill the stuck session?', topicId: 3 });
    expect(second.body.activityNote).toMatchObject({ deduped: true });
    expect(notes.notes(3)).toHaveLength(1);
    expect((await request(app).post('/action-claim/observe').send({ message: 'x', topicId: 3 })).status).toBe(401);
  });
});

describe('CMT-810 — GET /parallel-work/sentinel + /guards verifiability', () => {
  it('503 when the sentinel is not constructed (dark on this agent)', async () => {
    writeConfig({});
    const { app } = build({ sentinel: false });
    const r = await request(app).get('/parallel-work/sentinel').set(auth());
    expect(r.status).toBe(503);
  });

  it('200 with live counters when constructed; tick moves lastTickAt', async () => {
    writeConfig({ monitoring: { parallelWorkSentinel: { enabled: true, cadenceMinutes: 7 } } });
    const { app, sentinel } = build({ sentinel: true });
    const before = await request(app).get('/parallel-work/sentinel').set(auth());
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: true, tickCount: 0, lastTickAt: 0, lastTickAtIso: null, tickAgeMs: null, cadenceMinutes: 7 });
    const now = Date.now();
    sentinel!.tick(now);
    const after = await request(app).get('/parallel-work/sentinel').set(auth());
    expect(after.body).toMatchObject({ tickCount: 1, lastTickAt: now, lastTickAtIso: new Date(now).toISOString() });
    expect(after.body.tickAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('GET /guards: on-stale before the first tick, on-confirmed after (never on-unverified/not-instrumented)', async () => {
    writeConfig({ monitoring: { parallelWorkSentinel: { enabled: true } } });
    const registry = new GuardRegistry();
    const { app, sentinel } = build({ sentinel: true, registry });
    const row = async () => {
      const r = await request(app).get('/guards').set(auth());
      expect(r.status).toBe(200);
      return r.body.guards.find((g: { key: string }) => g.key === 'monitoring.parallelWorkSentinel.enabled');
    };
    const before = await row();
    expect(before.effective).toBe('on-stale');
    expect(before.runtimeReason).toBeUndefined();
    sentinel!.tick(Date.now());
    const after = await row();
    expect(after.effective).toBe('on-confirmed');
    expect(after.runtime.lastTickAt).toBeGreaterThan(0);
  });
});
