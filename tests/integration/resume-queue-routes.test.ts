// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * /sessions/resume-queue* through the real createRoutes pipeline
 * (reap-notify spec R2.10), plus the R2.7 emergency-stop reach:
 * stop-all pauses the queue; a per-topic stop cancels that topic's entries;
 * requeue/drain are refused 409 while paused (a Bearer holder cannot undo
 * an operator stop).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ResumeQueue } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer, type ResumeQueueDrainerDeps } from '../../src/monitoring/ResumeQueueDrainer.js';

let tmpDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-queue-routes-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeQueue(dryRun = false): ResumeQueue {
  const q = new ResumeQueue({ stateDir }, { dryRun });
  q.start();
  return q;
}

function makeDrainer(queue: ResumeQueue, over?: Partial<ResumeQueueDrainerDeps>): ResumeQueueDrainer {
  return new ResumeQueueDrainer(
    {
      queue,
      pressureTier: () => 'normal',
      canSpawnSession: () => true,
      sessionCountOk: () => true,
      migrationInFlight: () => false,
      liveSessionForTopic: () => false,
      currentResumeUuid: () => '11111111-1111-4111-8111-111111111111',
      topicOwnerElsewhere: () => false,
      topicBindingMatches: () => true,
      operatorStopSince: () => false,
      jobCheck: () => ({ ok: true }),
      pathExists: () => true,
      respawnTopic: async (entry) => `respawned-${entry.tmuxSession}`,
      triggerJob: async () => 'triggered',
      spawnAliveAfterGrace: async () => true,
      raiseAggregated: () => {},
      audit: () => {},
      ...over,
    },
    { requiredCalmTicks: 3 },
  );
}

function appWith(queue: ResumeQueue | null, drainer: ResumeQueueDrainer | null): express.Express {
  const ctx = {
    config: { projectName: 'test', projectDir: tmpDir, stateDir, port: 0, sessions: {} as never, scheduler: {} as never },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [], getCoherenceJournal: () => undefined },
    resumeQueue: queue,
    resumeDrainer: drainer,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

function enqueue(queue: ResumeQueue, topicId = 42) {
  return queue.considerEnqueue({
    sessionName: `sess-${topicId}`,
    tmuxSession: `tmux-${topicId}`,
    topicId,
    resumeUuid: '11111111-1111-4111-8111-111111111111',
    cwd: tmpDir,
    reason: 'quota-shed',
    disposition: 'terminal',
    origin: 'autonomous',
    workEvidence: ['build-or-autonomous-active'],
  });
}

describe('/sessions/resume-queue routes (R2.10)', () => {
  it('returns 503 when the queue is not wired', async () => {
    const res = await request(appWith(null, null)).get('/sessions/resume-queue');
    expect(res.status).toBe(503);
  });

  it('GET returns entries + paused + breaker + lastTickAt (wedged drainer detectable)', async () => {
    const queue = makeQueue();
    const drainer = makeDrainer(queue);
    enqueue(queue);
    await drainer.tick();
    const res = await request(appWith(queue, drainer)).get('/sessions/resume-queue');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.paused).toBe(false);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.lastTickAt).toBeTruthy();
    expect(res.body.breaker.open).toBe(false);
    queue.stop();
  });

  it('cancel: 200 on an open entry, 404 on unknown', async () => {
    const queue = makeQueue();
    const d = enqueue(queue);
    const app = appWith(queue, makeDrainer(queue));
    expect((await request(app).post(`/sessions/resume-queue/${d.entry!.id}/cancel`)).status).toBe(200);
    expect((await request(app).post('/sessions/resume-queue/nope/cancel')).status).toBe(404);
    queue.stop();
  });

  it('requeue clamps: 404 unknown; 409 for a cancelled entry; 200 for gave-up', async () => {
    const queue = makeQueue();
    const cancelled = enqueue(queue, 1);
    queue.cancel(cancelled.entry!.id);
    const gaveUp = enqueue(queue, 2);
    queue.transition(gaveUp.entry!.id, 'gave-up:max-attempts');
    const app = appWith(queue, makeDrainer(queue));
    expect((await request(app).post('/sessions/resume-queue/nope/requeue')).status).toBe(404);
    expect((await request(app).post(`/sessions/resume-queue/${cancelled.entry!.id}/requeue`)).status).toBe(409);
    expect((await request(app).post(`/sessions/resume-queue/${gaveUp.entry!.id}/requeue`)).status).toBe(200);
    queue.stop();
  });

  it('paused queue: requeue + drain are 409; /resume unpauses', async () => {
    const queue = makeQueue();
    const gaveUp = enqueue(queue, 2);
    queue.transition(gaveUp.entry!.id, 'gave-up:max-attempts');
    queue.pause('emergency stop');
    const app = appWith(queue, makeDrainer(queue));
    expect((await request(app).post(`/sessions/resume-queue/${gaveUp.entry!.id}/requeue`)).status).toBe(409);
    expect((await request(app).post('/sessions/resume-queue/drain')).status).toBe(409);
    const resume = await request(app).post('/sessions/resume-queue/resume');
    expect(resume.status).toBe(200);
    expect(resume.body.wasPaused).toBe(true);
    expect((await request(app).post(`/sessions/resume-queue/${gaveUp.entry!.id}/requeue`)).status).toBe(200);
    queue.stop();
  });

  it('manual drain skips calm-ticks ONLY (one immediate resume through the route)', async () => {
    const queue = makeQueue();
    const respawned: string[] = [];
    const drainer = makeDrainer(queue, {
      respawnTopic: async (entry) => {
        respawned.push(entry.id);
        return 'tmux-new';
      },
    });
    enqueue(queue);
    const app = appWith(queue, drainer);
    const res = await request(app).post('/sessions/resume-queue/drain');
    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(true);
    expect(respawned).toHaveLength(1);
    queue.stop();
  });
});

describe('emergency-stop reach (R2.7)', () => {
  it('POST /autonomous/stop-all pauses the queue', async () => {
    const queue = makeQueue();
    enqueue(queue);
    const app = appWith(queue, makeDrainer(queue));
    const res = await request(app).post('/autonomous/stop-all');
    expect(res.status).toBe(200);
    expect(queue.isPaused()).toBe(true);
    queue.stop();
  });

  it('POST /autonomous/sessions/:topic/stop cancels that topic entries only', async () => {
    const queue = makeQueue();
    enqueue(queue, 7);
    enqueue(queue, 8);
    const app = appWith(queue, makeDrainer(queue));
    await request(app).post('/autonomous/sessions/7/stop');
    const byKey = new Map(queue.list().map((e) => [e.stableKey, e.status]));
    expect(byKey.get('topic:7')).toBe('cancelled');
    expect(byKey.get('topic:8')).toBe('queued');
    queue.stop();
  });
});
