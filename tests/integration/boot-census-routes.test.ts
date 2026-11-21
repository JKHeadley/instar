/**
 * restart-lock-continuity A.3: GET /sessions/boot-census and POST .../reviewed
 * through the real createRoutes pipeline, with the resume queue OFF.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { BootSessionCensus, setActiveBootSessionCensus } from '../../src/core/BootSessionCensus.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';

const BOOT = Date.parse('2026-11-18T05:20:00Z');
let tmpDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-census-routes-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
});
afterEach(() => {
  setActiveBootSessionCensus(null);
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/boot-census-routes.test.ts' });
});

function appWith(records: Record<string, Session>, openWorkTopics: number[] = []): express.Express {
  const ctx = {
    config: { projectName: 'test', projectDir: tmpDir, stateDir, port: 0, sessions: {} as never, scheduler: {} as never, monitoring: {} },
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false },
    state: { getJobState: () => null, getSession: (id: string) => records[id] ?? null, listSessions: () => Object.values(records), getCoherenceJournal: () => undefined },
    commitmentTracker: { getActiveByTopicId: (t: number) => openWorkTopics.includes(t) ? [{ id: 'CMT-1', status: 'pending', createdAt: '2026-11-01T00:00:00Z' }] : [] },
    resumeQueue: null,
    resumeDrainer: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

const rec = (id: string, over: Partial<Session> = {}): Session => ({ id, name: id, status: 'running', tmuxSession: `echo-${id}`, startedAt: '2026-11-17T20:00:00Z', ...over } as Session);

describe('/sessions/boot-census', () => {
  it('answers with the resume queue disabled (the resume-queue route would 503)', async () => {
    const census = new BootSessionCensus({ stateDir, bootAt: BOOT, serverStartedAt: Date.now() });
    census.capture([rec('a', { telegramTopicId: 7 })]);
    setActiveBootSessionCensus(census);
    const app = appWith({ a: rec('a', { telegramTopicId: 7, status: 'completed' }) }, [7]);
    expect((await request(app).get('/sessions/resume-queue')).status).toBe(503);
    const res = await request(app).get('/sessions/boot-census');
    expect(res.status).toBe(200);
    expect(res.body.boots).toHaveLength(1);
    expect(res.body.boots[0].sessions[0]).toMatchObject({ sessionId: 'a', end: 'ended', mark: 'open work', topicCurrentlyActive: false });
  });

  it('?since= lists every retained boot after the cursor; reviewed marks one', async () => {
    const earlier = BOOT - 2 * 3600_000;
    new BootSessionCensus({ stateDir, bootAt: earlier }).capture([]);
    const census = new BootSessionCensus({ stateDir, bootAt: BOOT });
    census.capture([]);
    setActiveBootSessionCensus(census);
    const app = appWith({});
    const res = await request(app).get(`/sessions/boot-census?since=${earlier - 3600_000}`);
    expect(res.body.boots.map((b: { bootAt: number }) => b.bootAt)).toEqual([earlier, BOOT]);
    const mark = await request(app).post('/sessions/boot-census/reviewed').send({ bootAt: earlier });
    expect(mark.status).toBe(200);
    const after = await request(app).get(`/sessions/boot-census?since=${earlier - 3600_000}`);
    expect(after.body.boots[0].reviewedAt).toBeTruthy();
  });

  it('says unavailable when no census was started', async () => {
    const res = await request(appWith({})).get('/sessions/boot-census');
    expect(res.status).toBe(200);
    expect(res.body.unavailable).toBeTruthy();
  });

  it('reviewed refuses a missing bootAt', async () => {
    setActiveBootSessionCensus(new BootSessionCensus({ stateDir, bootAt: BOOT }));
    expect((await request(appWith({})).post('/sessions/boot-census/reviewed').send({})).status).toBe(400);
  });
});
