/**
 * Integration tests for fork-bomb prevention (the SIMPLE design).
 * Spec: docs/specs/forkbomb-prevention-simple.md §Tests (Integration).
 *
 * - GET /spawn-limiter returns the real host-spawn-semaphore status (cap, live
 *   holders, waiters, acquire budget).
 * - N concurrent evaluate() calls through ONE shared spawn-capped provider →
 *   at most `cap` spawn concurrently; the rest wait-then-shed.
 * - a gating call on shed is HELD (typed capacity error → the gate fails closed).
 * - a background (non-gating) call on shed throws the same typed error so its
 *   existing catch degrades loud (it never silently passes).
 * - the lint flags a fresh raw provider construction outside the funnel.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import {
  HostSpawnSemaphore,
  configureHostSpawnSemaphore,
  _resetHostSpawnSemaphoreForTest,
  getHostSpawnSemaphore,
} from '../../src/core/hostSpawnSemaphore.js';
import {
  SpawnCapIntelligenceProvider,
  isCapacityUnavailable,
  _resetSpawnPollersForTest,
} from '../../src/core/SpawnCapIntelligenceProvider.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function minimalCtx(): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWithRoutes(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(minimalCtx()));
  return app;
}

describe('Fork-bomb prevention (integration)', () => {
  let holdersPath: string;

  beforeEach(() => {
    _resetHostSpawnSemaphoreForTest();
    _resetSpawnPollersForTest();
    holdersPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-int-')), 'holders.json');
  });
  afterEach(() => {
    _resetHostSpawnSemaphoreForTest();
    _resetSpawnPollersForTest();
    try { SafeFsExecutor.safeRmSync(path.dirname(holdersPath), { recursive: true, force: true, operation: 'tests/integration/spawn-cap.test.ts:afterEach' }); } catch { /* ignore */ }
  });

  describe('GET /spawn-limiter', () => {
    it('reports the configured cap and live holder count', async () => {
      configureHostSpawnSemaphore({ maxConcurrent: 5, acquireMs: 4000, waitersMax: 32 });
      const res = await request(appWithRoutes()).get('/spawn-limiter');
      expect(res.status).toBe(200);
      expect(res.body.cap).toBe(5);
      expect(res.body.acquireMs).toBe(4000);
      expect(res.body.waitersMax).toBe(32);
      expect(typeof res.body.liveHolders).toBe('number');
      expect(typeof res.body.available).toBe('number');
      expect(typeof res.body.saturated).toBe('boolean');
      expect(typeof res.body.waiters).toBe('number');
    });

    it('reflects a saturated cap after slots are taken', async () => {
      configureHostSpawnSemaphore({ maxConcurrent: 2 });
      const sem = getHostSpawnSemaphore();
      sem.acquire('a');
      sem.acquire('b');
      const res = await request(appWithRoutes()).get('/spawn-limiter');
      expect(res.body.cap).toBe(2);
      expect(res.body.liveHolders).toBe(2);
      expect(res.body.available).toBe(0);
      expect(res.body.saturated).toBe(true);
    });
  });

  describe('N concurrent evaluate() through one shared spawn-capped provider', () => {
    function makeSem(cap: number): HostSpawnSemaphore {
      return new HostSpawnSemaphore({
        holdersPath, cap,
        hostname: () => 'int-host', pidAlive: () => true, isPathHostLocal: () => true,
        genId: () => `int:${Math.random().toString(36).slice(2)}`,
      });
    }

    it('bounds concurrent spawns to the cap; the rest wait-then-shed (gating HELD)', async () => {
      const CAP = 3;
      const sem = makeSem(CAP);
      let running = 0;
      let maxRunning = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const inner: IntelligenceProvider = {
        async evaluate(_p: string, _o?: IntelligenceOptions) {
          running++; maxRunning = Math.max(maxRunning, running);
          await gate;
          running--;
          return 'ok';
        },
      };
      const wrapped = new SpawnCapIntelligenceProvider(inner, {
        semaphore: sem, acquireMs: 80, pollIntervalMs: 10, sleep: async () => {},
      });

      // 8 concurrent GATING calls — only CAP run; the other 5 shed (held).
      const calls = Array.from({ length: 8 }, () =>
        wrapped.evaluate('p', { attribution: { component: 'TestGate', gating: true } }).catch((e) => e),
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(maxRunning).toBeLessThanOrEqual(CAP);
      release();
      const settled = await Promise.all(calls);
      const ok = settled.filter((r) => r === 'ok').length;
      const shed = settled.filter((r) => isCapacityUnavailable(r)).length;
      expect(ok + shed).toBe(8);
      expect(shed).toBeGreaterThan(0); // the cap actually shed the overflow
      expect(maxRunning).toBeLessThanOrEqual(CAP);
    });

    it('a background (non-gating) call on shed throws the SAME typed error (degrade loud, never silent)', async () => {
      const sem = makeSem(1);
      sem.acquire('occupier'); // saturate
      const wrapped = new SpawnCapIntelligenceProvider(
        { async evaluate() { return 'unreached'; } },
        { semaphore: sem, acquireMs: 40, pollIntervalMs: 10, sleep: async () => {} },
      );
      const err = await wrapped
        .evaluate('p', { attribution: { component: 'BackgroundSweep', gating: false } })
        .catch((e) => e);
      // The wrapper throws the typed error regardless of gating; the CALLER's
      // existing catch is what degrades-loud for background work. This proves the
      // shed is observable (thrown), never a silent success.
      expect(isCapacityUnavailable(err)).toBe(true);
    });
  });

  describe('lint flags a raw provider construction outside the funnel', () => {
    it('lint-no-unbounded-llm-spawn fails on a fresh raw `new ClaudeCliIntelligenceProvider(...)`', () => {
      const repoRoot = path.resolve(__dirname, '../..');
      const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lint-'));
      const offender = path.join(sandboxDir, 'offender.ts');
      fs.writeFileSync(
        offender,
        `const p = new ClaudeCliIntelligenceProvider('/bin/claude');\nexport { p };\n`,
      );
      let failed = false;
      let output = '';
      try {
        execFileSync(
          process.execPath,
          [path.join(repoRoot, 'scripts/lint-no-unbounded-llm-spawn.js'), offender],
          { encoding: 'utf-8' },
        );
      } catch (err: any) {
        failed = true;
        output = String(err.stdout ?? '') + String(err.stderr ?? '');
      } finally {
        try { SafeFsExecutor.safeRmSync(sandboxDir, { recursive: true, force: true, operation: 'tests/integration/spawn-cap.test.ts:lint-sandbox-cleanup' }); } catch { /* ignore */ }
      }
      expect(failed).toBe(true);
      expect(output).toMatch(/direct LLM-CLI provider construction outside the spawn-cap funnel/);
    });
  });
});
