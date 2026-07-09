// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the NON-GATING failure-swap
 * (docs/specs/nongating-failure-swap.md).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses) with a
 * router whose `nonGatingFailureSwap.enabled` is resolved through the SHIPPED default
 * expression (`config.intelligence?.nonGatingFailureSwap?.enabled ?? true`) against a config
 * that does NOT set it — proving the feature ships ON by default and is genuinely live (not
 * dark). It verifies (a) the intelligence-routing route is alive (200) and (b) the wired
 * router actually performs the non-gating swap when a primary invocation fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { InstarConfig, IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}
function okProvider(label: string): IntelligenceProvider & { calls: number } {
  return { calls: 0, async evaluate() { this.calls++; return label; } } as IntelligenceProvider & { calls: number };
}
function invocationFailProvider(msg = 'codex exec failed'): IntelligenceProvider {
  return { async evaluate() { throw new Error(msg); } };
}

const NON_GATING: IntelligenceOptions = { attribution: { component: 'TopicIntentExtractor' } };

describe('non-gating failure-swap E2E lifecycle (feature is alive + ON by default)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let router: IntelligenceRouter;
  const pi = okProvider('pi');
  const AUTH = 'test-e2e-nongating-swap';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nongating-swap-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
      // NOTE: config.intelligence is intentionally UNSET, so the shipped default expression
      // below must resolve `enabled` to TRUE (proving the feature ships ON by default).
    } as InstarConfig;

    const built: Record<string, IntelligenceProvider> = {
      'codex-cli': invocationFailProvider(), // the primary invocation fails (the 28% class)
      'pi-cli': pi,
    };
    router = new IntelligenceRouter({
      defaultProvider: okProvider('claude'),
      defaultFramework: 'claude-code',
      // TopicIntentExtractor → codex primary (override), pi/gemini/claude tail — the codex-active
      // shape. Routed via `overrides` (not `default`) so the router's own defaultFramework stays
      // claude-code, matching the computed-default policy on a codex-active agent.
      resolveConfig: () => ({ overrides: { TopicIntentExtractor: 'codex-cli' }, failureSwap: ['pi-cli', 'gemini-cli', 'claude-code'] }),
      buildProvider: (fw) => built[fw] ?? null,
      swapAttemptTimeoutMs: 5000,
      // The SHIPPED default expression from src/commands/server.ts — config unset ⇒ enabled:true.
      nonGatingFailureSwap: {
        enabled: (config as InstarConfig).intelligence?.nonGatingFailureSwap?.enabled ?? true,
        maxAttempts: (config as InstarConfig).intelligence?.nonGatingFailureSwap?.maxAttempts,
      },
    });

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      intelligence: router,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/nongating-failure-swap-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /intelligence/routing is alive (200, not 503)', async () => {
    const res = await request(app).get('/intelligence/routing').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.defaultFramework).toBe('claude-code');
  });

  it('the wired router performs the non-gating swap by DEFAULT (feature is alive, not dark)', async () => {
    // The primary (codex) invocation fails with zero usage; with the shipped default ON, a
    // non-gating call swaps to the next active off-Claude framework (pi) instead of hard-erroring.
    const result = await router.evaluate('classify this', NON_GATING);
    expect(result).toBe('pi');
    expect(pi.calls).toBeGreaterThan(0);
  });
});
