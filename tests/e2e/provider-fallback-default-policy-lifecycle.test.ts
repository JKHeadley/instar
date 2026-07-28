// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the provider-fallback DEFAULT
 * POLICY (docs/specs/provider-fallback-default-policy.md §7).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses),
 * passing a real IntelligenceRouter wired with the COMPUTED DEFAULT (no operator
 * componentFrameworks) for a codex-active agent, and verifies:
 *  - GET /intelligence/routing is ALIVE (200, not 503) and reflects the default policy
 *    live: a gating component (sentinel) resolves OFF Claude (codex) while a `job` stays
 *    on the agent default.
 *  - Wiring-integrity (M11): a GATING CALLER receives the router's re-throw when the
 *    primary AND every swap target are down — asserted AT THE CALLER, proving the
 *    router→caller fail-closed wiring (the router never silently degrades to a brittle
 *    heuristic; the throw reaches the caller's own fail policy).
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
import { resolveInternalFrameworkDefault } from '../../src/core/internalFrameworkDefault.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { InstarConfig, IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}
function fakeProvider(label: string): IntelligenceProvider {
  return { async evaluate() { return label; } };
}
function throwingProvider(msg = 'down'): IntelligenceProvider {
  return { async evaluate() { throw new Error(msg); } };
}

/** Router wired like the server construction site (§4.6) with the computed default. */
function routerWithComputedDefault(
  activeSet: IntelligenceFramework[],
  built: Partial<Record<IntelligenceFramework, IntelligenceProvider | null>>,
  defaultProvider: IntelligenceProvider,
): IntelligenceRouter {
  const computedDefault = resolveInternalFrameworkDefault(activeSet);
  return new IntelligenceRouter({
    defaultProvider,
    defaultFramework: 'claude-code',
    resolveConfig: () => computedDefault,
    buildProvider: (fw) => built[fw] ?? null,
    swapAttemptTimeoutMs: 5000,
  });
}

describe('Provider-fallback default policy E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-provider-fallback-default';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-fallback-e2e-'));
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
    } as InstarConfig;

    // Codex-active agent: computed default routes sentinel/gate/reflector → codex-cli.
    const router = routerWithComputedDefault(
      ['codex-cli', 'gemini-cli', 'claude-code'],
      { 'codex-cli': fakeProvider('codex'), 'gemini-cli': fakeProvider('gemini') },
      fakeProvider('claude'),
    );

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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/provider-fallback-default-policy-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /intelligence/routing is alive (200, not 503) and reflects the default policy live', async () => {
    const res = await request(app).get('/intelligence/routing').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.defaultFramework).toBe('claude-code');

    const sentinel = res.body.components.find((c: any) => c.component === 'PresenceProxy');
    expect(sentinel).toMatchObject({ category: 'sentinel', framework: 'codex-cli', available: true });

    // `job` (cost-bearing background work) stays on the agent default — NOT auto-armed.
    const sweep = res.body.components.find((c: any) => c.component === 'CartographerSweep');
    expect(sweep).toMatchObject({ category: 'job', framework: 'claude-code' });

    expect(res.body.coverage.routedOffDefault).toBeGreaterThan(0);
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/intelligence/routing');
    expect(res.status).toBe(401);
  });
});

describe('Wiring-integrity (M11): a gating CALLER receives the router re-throw when all providers are down', () => {
  it('the router re-throws to the gating caller when primary + every swap target are down', async () => {
    // primary (codex) down, all swap targets (gemini, claude tail) down too.
    const router = routerWithComputedDefault(
      ['codex-cli', 'gemini-cli', 'claude-code'],
      { 'codex-cli': throwingProvider('codex down'), 'gemini-cli': throwingProvider('gemini down') },
      throwingProvider('claude tail down'), // the claude-code swap target resolves here
    );

    // Assert AT THE ROUTER (the swap engine re-throws — never silently degrades).
    const gating: IntelligenceOptions = { attribution: { component: 'ExternalOperationGate', gating: true } };
    await expect(router.evaluate('x', gating)).rejects.toThrow();

    // Assert AT A REAL GATING CALLER: MessagingToneGate (the tonight-incident gate)
    // routes through the router and receives the throw in its own catch. The
    // wiring-integrity point is that the throw REACHES the caller (the router did not
    // swallow it into a brittle heuristic), so the caller's OWN fail policy decides.
    // CONTRACT (tone-gate-graceful-degradation F4): with failClosedOnExhaustion UNSET
    // (the default), the delivery-path tone gate DEGRADES to the in-process
    // deterministic leak floor on an exhausted chain — a CLEAN message SENDS (the user
    // is never silently cut off) while a real leaked artifact still HOLDS. The throw
    // having reached the caller is proven by degradedToDeterministic (only the caller's
    // catch runs the floor). Operators restore pure-hold with failClosedOnExhaustion:true.
    const toneGate = new MessagingToneGate(router);
    const clean = await toneGate.review('hello there', {
      channel: 'telegram', recentMessages: [], signals: {},
    } as any);
    expect(clean.pass).toBe(true); // clean → degrade-SEND, not silenced
    expect(clean.degradedToDeterministic).toBe(true); // proves the throw reached the caller's floor

    // A real leak on the same exhausted chain still HOLDS — degrade is not a blanket pass.
    const leak = await toneGate.review('see .instar/config.json', {
      channel: 'telegram', recentMessages: [], signals: {},
    } as any);
    expect(leak.pass).toBe(false);
    expect(leak.failedClosed).toBe(true);

    // Operator strict override restores pure-hold even for a clean message.
    const strict = new MessagingToneGate(router, { failClosedOnExhaustion: true });
    const held = await strict.review('hello there', {
      channel: 'telegram', recentMessages: [], signals: {},
    } as any);
    expect(held.failedClosed).toBe(true);
    expect(held.pass).toBe(false);
  });

  it('a FAIL-CLOSED gating caller propagates the throw (does not silently pass)', async () => {
    // A minimal fail-closed gating caller: it must re-throw / refuse on a router throw,
    // never degrade to a permissive default. This is the contract the spec protects.
    const router = routerWithComputedDefault(
      ['codex-cli', 'claude-code'],
      { 'codex-cli': throwingProvider('codex down') },
      throwingProvider('claude tail down'),
    );
    const failClosedGate = async (provider: IntelligenceProvider): Promise<'allow' | 'block'> => {
      try {
        await provider.evaluate('verdict?', { attribution: { component: 'ExternalOperationGate', gating: true } });
        return 'allow';
      } catch {
        return 'block'; // fail CLOSED — the throw reached us, we refuse.
      }
    };
    await expect(failClosedGate(router)).resolves.toBe('block');
  });
});
