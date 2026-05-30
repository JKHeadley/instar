// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests for GET /codex/usage — the codex `/status`-equivalent
 * rate-limit surface over HTTP. Verifies the route is actually reachable
 * (not dead code) and returns the structured snapshot read from a rollout on
 * disk, plus the both-sides boundary: data present → available:true; no codex
 * data → available:false (and still 200, never 503 — it's a disk reader, not
 * a wired-or-not subsystem).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function minimalCtx(): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, tokenLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function tokenCountLine(primaryUsed: number, secondaryUsed: number, reached: string | null = null): string {
  return JSON.stringify({
    timestamp: '2026-05-30T19:22:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: 1780171524 },
        secondary: { used_percent: secondaryUsed, window_minutes: 10080, resets_at: 1780174809 },
        plan_type: 'plus',
        rate_limit_reached_type: reached,
      },
    },
  });
}

describe('GET /codex/usage (integration)', () => {
  let home: string;
  let app: express.Express;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-route-'));
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(minimalCtx()));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/codex-usage-route.test.ts:cleanup' });
  });

  function writeRollout(uuid: string): void {
    const dir = path.join(home, 'sessions', '2026', '05', '30');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `rollout-2026-05-30T12-00-00-${uuid}.jsonl`),
      JSON.stringify({ timestamp: '2026-05-30T19:20:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } }) +
        '\n' +
        tokenCountLine(13, 93) +
        '\n',
    );
  }

  it('returns the structured rate-limit snapshot when codex data exists', async () => {
    writeRollout('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const res = await request(app).get('/codex/usage').query({ codexHome: home });
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.usage.secondary.usedPercent).toBe(93);
    expect(res.body.usage.secondary.remainingPercent).toBe(7);
    expect(res.body.usage.primary.usedPercent).toBe(13);
    expect(res.body.usage.model).toBe('gpt-5.5');
    expect(res.body.usage.planType).toBe('plus');
    expect(res.body.usage.threadId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('surfaces the exhausted-window signal', async () => {
    const dir = path.join(home, 'sessions', '2026', '05', '30');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'rollout-2026-05-30T12-00-00-ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
      tokenCountLine(100, 100, 'secondary') + '\n',
    );
    const res = await request(app).get('/codex/usage').query({ codexHome: home });
    expect(res.status).toBe(200);
    expect(res.body.usage.rateLimitReachedType).toBe('secondary');
  });

  it('returns available:false (still 200) when there is no codex data', async () => {
    const res = await request(app).get('/codex/usage').query({ codexHome: home });
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.usage).toBeNull();
  });
});
