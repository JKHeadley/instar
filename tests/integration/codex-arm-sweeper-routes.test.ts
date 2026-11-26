/**
 * GET /codex-arm-sweeper through the real createRoutes pipeline.
 *  - 503 when the sweeper is not wired.
 *  - 200 with the posture + counters when present.
 *  - the counters reflect a real pass (the route is not a static stub).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { CodexArmSessionSweeper } from '../../src/monitoring/CodexArmSessionSweeper.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = 1_800_000_000_000;

function ctxWith(stateDir: string, sweeper: CodexArmSessionSweeper | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
    tokenLedger: null,
    codexArmSessionSweeper: sweeper,
    startTime: new Date(),
  } as unknown as RouteContext;
}

describe('GET /codex-arm-sweeper (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cass-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/codex-arm-sweeper-routes.test.ts' });
  });

  function appWith(sweeper: CodexArmSessionSweeper | null): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(stateDir, sweeper)));
    return app;
  }

  it('returns 503 when the sweeper is not wired', async () => {
    const res = await request(appWith(null)).get('/codex-arm-sweeper');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/codex arm session sweeper/i);
  });

  it('a DISABLED sweeper still answers 200 with enabled:false — the status code is not the posture', async () => {
    const sweeper = new CodexArmSessionSweeper(
      { enabled: false },
      { listSessions: () => [], killSession: () => {}, now: () => NOW },
    );
    const res = await request(appWith(sweeper)).get('/codex-arm-sweeper');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('returns the posture and counters when wired', async () => {
    const killed: string[] = [];
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [
          { name: `instar-codex-arm-${(NOW - 3_600_000).toString(36)}`, createdEpochSec: Math.floor((NOW - 3_600_000) / 1000) },
          { name: `instar-codex-arm-${(NOW - 10_000).toString(36)}`, createdEpochSec: Math.floor((NOW - 10_000) / 1000) },
          { name: 'sagemind-server', createdEpochSec: Math.floor((NOW - 86_400_000) / 1000) },
        ],
        killSession: (n) => { killed.push(n); },
        now: () => NOW,
      },
    );

    // Before any pass: the shape is present and the counters are honest zeros.
    const before = await request(appWith(sweeper)).get('/codex-arm-sweeper');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: true, dryRun: false, passes: 0, killed: 0, kept: 0, errors: 0 });
    expect(before.body.maxAgeMs).toBeGreaterThanOrEqual(120_000);
    expect(before.body.lastPassAt).toBeNull();

    sweeper.sweep();

    // After a real pass the route reports it — proving the handler reads live state
    // rather than a canned object.
    const after = await request(appWith(sweeper)).get('/codex-arm-sweeper');
    expect(after.status).toBe(200);
    expect(after.body.passes).toBe(1);
    expect(after.body.killed).toBe(1);
    expect(after.body.kept).toBe(1); // the live arm; the unrelated session is never counted
    expect(after.body.lastKills[0].session).toBe(`instar-codex-arm-${(NOW - 3_600_000).toString(36)}`);
    expect(killed).toEqual([`instar-codex-arm-${(NOW - 3_600_000).toString(36)}`]);
  });
});
