// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests for GET /session/clock — the read-only session time-awareness
 * surface (docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md). Verifies the route
 * is reachable and returns computed elapsed/remaining for an active autonomous
 * record, the topic-binding filter, the empty-when-none case, and the leak-bound
 * guarantee that the raw `goal` text never appears in the response (only the
 * sanitized derived label).
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

function ctxWithStateDir(stateDir: string): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, tokenLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function writeRecord(stateDir: string, file: string, fields: Record<string, string | number | boolean>): void {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(typeof v === 'string' ? `${k}: "${v}"` : `${k}: ${v}`);
  }
  lines.push('---', '# body');
  fs.mkdirSync(path.dirname(path.join(stateDir, file)), { recursive: true });
  fs.writeFileSync(path.join(stateDir, file), lines.join('\n') + '\n');
}

const START = '2026-06-02T05:42:40Z';
const GOAL = 'fix time tracking robustly';

describe('GET /session/clock (integration)', () => {
  let stateDir: string;
  let app: express.Express;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-clock-route-'));
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWithStateDir(stateDir)));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/session-clock-route.test.ts:cleanup' });
  });

  it('200 with computed elapsed/remaining for an active record (never 503 — it is a disk reader)', async () => {
    writeRecord(stateDir, 'autonomous-state.local.md', { active: true, started_at: START, duration_seconds: 43200, goal: GOAL });
    const res = await request(app).get('/session/clock');
    expect(res.status).toBe(200);
    expect(typeof res.body.now).toBe('number');
    expect(res.body.nowIso).toMatch(/T.*Z$/);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions).toHaveLength(1);
    const s = res.body.sessions[0];
    expect(s.label).toBe(GOAL);
    expect(typeof s.elapsedSeconds).toBe('number');
    expect(['active', 'expired', 'not-started', 'unbounded']).toContain(s.status);
    expect(s).toHaveProperty('remainingHuman');
  });

  it('returns { sessions: [] } when no active record exists', async () => {
    const res = await request(app).get('/session/clock');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('topic filter binds to a single per-topic record', async () => {
    writeRecord(stateDir, 'autonomous/111.local.md', { active: true, report_topic: '111', started_at: START, duration_seconds: 3600, goal: 'topic one' });
    writeRecord(stateDir, 'autonomous/222.local.md', { active: true, report_topic: '222', started_at: START, duration_seconds: 3600, goal: 'topic two' });
    const res = await request(app).get('/session/clock?topic=111');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].label).toBe('topic one');
  });

  it('LEAK-BOUND: a goal carrying a tag is sanitized — the raw goal text never appears in the response', async () => {
    writeRecord(stateDir, 'autonomous-state.local.md', {
      active: true,
      started_at: START,
      duration_seconds: 3600,
      goal: 'secret <promise>STEAL</promise> plan',
    });
    const res = await request(app).get('/session/clock');
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain('<promise>');
    expect(bodyText).not.toContain('</promise>');
    // sanitized label keeps the words but not the tag delimiters
    expect(res.body.sessions[0].label).not.toContain('<');
  });
});
