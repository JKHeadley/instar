// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — reads source only.

/**
 * E2E lifecycle test — GeminiLoopRunner production wiring (need-gem-002, increment 2).
 *
 * Two "feature is alive" gates (Testing Integrity Standard Tier 3):
 *
 *  1. ALIVE: assemble the components server.ts wires (the production deps via
 *     geminiLoopProduction + the GeminiLoopRunner + createRoutes) and prove the
 *     route ADMITS a run end-to-end (202) — i.e. the feature returns 202, not 503.
 *     A stub spawn keeps it gemini-free; the real production factories
 *     (createGeminiLoopSpawn / createGeminiHandleCapture / createQuotaBudgetGate)
 *     are exercised for shape so the wiring is genuinely the production path.
 *
 *  2. WIRED source check: server.ts must ACTUALLY construct + thread the runner
 *     (not ship it as an orphan class while release notes claim it's wired — the
 *     PR #334 sin). Greps server.ts for `new GeminiLoopRunner(` + the ctx field,
 *     and routes.ts for the route.
 *
 * Spec: docs/specs/gemini-multi-turn-loop-driver.md
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { GeminiLoopRunner } from '../../src/monitoring/GeminiLoopRunner.js';
import {
  createGeminiLoopSpawn,
  createGeminiHandleCapture,
  createQuotaBudgetGate,
} from '../../src/monitoring/geminiLoopProduction.js';
import { DEFAULT_DONE_SENTINEL } from '../../src/monitoring/GeminiLoopDriver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

describe('GeminiLoopRunner — E2E lifecycle (feature is alive)', () => {
  it('Gate 1: the production-wired route ADMITS a run (202, not 503)', async () => {
    // Exercise the real production factories for shape (no gemini call yet)...
    expect(typeof createGeminiLoopSpawn('gemini', 1000)).toBe('function');
    expect(typeof createGeminiHandleCapture('gemini')).toBe('function');
    const budgetGate = createQuotaBudgetGate(null); // fail-open with no tracker
    expect(budgetGate()).toEqual({ ok: true });

    // ...then build the runner the way server.ts does, but with a gemini-free
    // stub spawn so the async loop completes without touching the network.
    const runner = new GeminiLoopRunner({
      config: {
        enabled: true,
        model: 'gemini-2.5-flash',
        maxTurns: 4,
        minTurnIntervalMs: 0,
        maxConcurrent: 1,
        maxRetainedRuns: 50,
      },
      spawn: async () => ({ exitCode: 0, stdout: `ok\n${DEFAULT_DONE_SENTINEL}`, stderr: '', truncated: false }),
      captureHandle: async () => 'handle-uuid',
      budgetGate,
    });

    const ctx = {
      config: { projectName: 't', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
      sessionManager: { listRunningSessions: () => [] } as any,
      state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
      geminiLoopRunner: runner,
      startTime: new Date(),
    } as unknown as RouteContext;

    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));

    const res = await request(app).post('/gemini-loop/runs').send({ goalPrompt: 'prove the loop is alive' });
    expect(res.status).toBe(202); // alive — not 503
    expect(res.body.runId).toBeTruthy();
  });

  it('Gate 2: server.ts constructs + threads the runner (not an orphan class)', () => {
    const serverSrc = fs.readFileSync(path.join(SRC, 'commands', 'server.ts'), 'utf8');
    // actually instantiated in the boot path...
    expect(serverSrc).toMatch(/new GeminiLoopRunner\(/);
    // ...gated dark with the developmentAgent gate...
    expect(serverSrc).toMatch(/geminiLoopDriver/);
    expect(serverSrc).toMatch(/developmentAgent/);
    // ...and threaded into the route context.
    expect(serverSrc).toMatch(/geminiLoopRunner,/);

    const routesSrc = fs.readFileSync(path.join(SRC, 'server', 'routes.ts'), 'utf8');
    expect(routesSrc).toMatch(/\/gemini-loop\/runs/);
    expect(routesSrc).toMatch(/ctx\.geminiLoopRunner/);
  });
});
