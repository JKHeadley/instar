/**
 * GET /sessions/reap-log through the real createRoutes pipeline (§P4).
 *  - 503 when the reap-log is not wired.
 *  - 200 with recorded reaped/skipped entries when present.
 *  - read-only (no write methods), ?limit bounds the tail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function ctxWith(stateDir: string, reapLog: ReapLog | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
    tokenLedger: null,
    reapLog,
    startTime: new Date(),
  } as unknown as RouteContext;
}

describe('GET /sessions/reap-log (integration §P4)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaplog-route-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/reap-log-route.test.ts' });
  });

  function appWith(reapLog: ReapLog | null): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(stateDir, reapLog)));
    return app;
  }

  it('returns 503 when the reap-log is not wired', async () => {
    const res = await request(appWith(null)).get('/sessions/reap-log');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
  });

  it('returns 200 with recorded reaped + skipped entries', async () => {
    const log = new ReapLog(stateDir, () => 'm1');
    log.recordReaped({ session: 'sess-a', tmuxSession: 'ta', reason: 'idle-zombie', disposition: 'terminal', origin: 'autonomous' });
    log.recordSkipped({ session: 'sess-b', tmuxSession: 'tb', reason: 'age-limit', skipped: 'protected', origin: 'autonomous' });

    const res = await request(appWith(log)).get('/sessions/reap-log');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({ type: 'reaped', session: 'sess-a', reason: 'idle-zombie' });
    expect(res.body.entries[1]).toMatchObject({
      type: 'skipped',
      skipped: 'protected',
      disposition: 'skipped:protected',
    });
  });

  it('honours ?limit by returning only the most-recent N', async () => {
    const log = new ReapLog(stateDir);
    for (let i = 0; i < 8; i++) log.recordReaped({ session: `s${i}`, tmuxSession: `t${i}`, reason: 'idle-zombie' });
    const res = await request(appWith(log)).get('/sessions/reap-log?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.entries.map((e: { session: string }) => e.session)).toEqual(['s5', 's6', 's7']);
  });

  it('is read-only — POST/PUT/DELETE are not registered', async () => {
    const app = appWith(new ReapLog(stateDir));
    expect((await request(app).post('/sessions/reap-log')).status).toBe(404);
    expect((await request(app).delete('/sessions/reap-log')).status).toBe(404);
  });
});
