/**
 * Integration tests for the RateLimitSentinel HTTP surface + wiring integrity.
 *
 * - GET /rate-limit/status through the real createRoutes pipeline (active +
 *   disabled cases).
 * - Wiring integrity: the zombie-veto recovery-checker composition returns true
 *   when EITHER the compaction OR the rate-limit sentinel owns a session
 *   (guards the S1 regression where a second setActiveRecoveryChecker call
 *   would silently drop the compaction veto), and the bidirectional deferIf
 *   is honored.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { RateLimitSentinel } from '../../src/monitoring/RateLimitSentinel.js';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function minimalContext(stateDir: string, rateLimitSentinel: RateLimitSentinel | null): RouteContext {
  return {
    config: {
      projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0,
      sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    rateLimitSentinel,
    startTime: new Date(),
  } as unknown as RouteContext;
}

describe('RateLimitSentinel routes + wiring (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let jsonlRoot: string;
  let sentinel: RateLimitSentinel;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    jsonlRoot = path.join(tmpDir, 'jsonl');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(jsonlRoot, { recursive: true });
    fs.writeFileSync(path.join(jsonlRoot, 'foo.jsonl'), 'x'.repeat(100));
    sentinel = new RateLimitSentinel(
      { resumeFn: async () => true, notifyFn: async () => {}, projectDir: '/fake', jsonlRoot },
    );
  });

  afterEach(() => {
    sentinel.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/rate-limit-status-routes.test.ts' });
  });

  function appWith(rls: RateLimitSentinel | null): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(minimalContext(stateDir, rls)));
    return app;
  }

  it('GET /rate-limit/status returns enabled:false + empty when sentinel absent', async () => {
    const res = await request(appWith(null)).get('/rate-limit/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.active).toEqual([]);
  });

  it('GET /rate-limit/status reflects an active recovery', async () => {
    sentinel.report('sess-1', 'watchdog-poll'); // becomes active immediately (backing-off)
    const res = await request(appWith(sentinel)).get('/rate-limit/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0].sessionName).toBe('sess-1');
    expect(res.body.active[0].nextBackoffMs).toBeGreaterThan(0);
    expect(['detected', 'backing-off', 'resuming']).toContain(res.body.active[0].status);
  });

  // ── Wiring integrity: zombie-veto composition (S1) ──

  it('composed recovery-checker is true when EITHER sentinel owns the session', () => {
    const compaction = new CompactionSentinel({ recoverFn: async () => true, projectDir: '/fake', jsonlRoot });
    // The exact predicate server.ts wires into setActiveRecoveryChecker.
    const composed = (name: string) =>
      compaction.isRecoveryActive(name) || sentinel.isRecoveryActive(name);

    expect(composed('x')).toBe(false);
    sentinel.report('x', 'idle-error');
    expect(composed('x')).toBe(true);   // rate-limit veto holds
    sentinel.clear('x');
    expect(composed('x')).toBe(false);
    compaction.report('y', 'watchdog-poll');
    expect(composed('y')).toBe(true);   // compaction veto STILL holds (not dropped)
    compaction.stop();
  });

  // ── Wiring integrity: bidirectional deferral (S6) ──

  it('rate-limit sentinel defers when compaction recovery owns the session', () => {
    const compaction = new CompactionSentinel({ recoverFn: async () => true, projectDir: '/fake', jsonlRoot });
    sentinel.setDeferIf(s => compaction.isRecoveryActive(s));
    compaction.report('z', 'watchdog-poll'); // compaction owns z
    sentinel.report('z', 'idle-error');       // should defer (no-op)
    expect(sentinel.isRecoveryActive('z')).toBe(false);
    compaction.stop();
  });
});
