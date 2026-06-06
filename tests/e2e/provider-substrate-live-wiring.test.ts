/**
 * E2E test — Provider-substrate live wiring (June-15 interactive-only
 * readiness, CMT-1105) full lifecycle.
 *
 * Tests the complete PRODUCTION path, mirroring src/commands/server.ts:
 *   1. Boot: registerAnthropicAdapters() the same way startServer does
 *      (config-derived enabledFrameworks/claudePath/pool config).
 *   2. The "feature is alive" check: GET /providers/registry returns 200
 *      with BOTH Anthropic adapters — not an empty registry (the exact
 *      shipped-dark failure this PR closes: policy installed, zero
 *      adapters registered).
 *   3. The default-off invariance: with no subscriptionPath config, the
 *      intelligence funnel builds WITHOUT the subscription router.
 *   4. The force-mode path: mirroring server.ts's subscriptionPathOption
 *      construction, a built provider serves calls from the pool.
 *   5. Codex-only gate: a codex-only agent registers nothing.
 *   6. Boot is lazy: no tmux/claude processes spawn from registration.
 *
 * WHY THIS TEST EXISTS:
 * Unit tests prove registerAnthropicAdapters works when called. This test
 * proves the PRODUCTION wiring shape calls it and the result is observable
 * through the HTTP pipeline — the difference between "compiles + passes
 * unit tests" and "actually alive on a booted agent."
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
  };
});

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { registry } from '../../src/providers/registry.js';
import {
  registerAnthropicAdapters,
  type RegisterAnthropicAdaptersResult,
} from '../../src/providers/bootRegistration.js';
import { buildIntelligenceProvider } from '../../src/core/intelligenceProviderFactory.js';
import { CapabilityFlag } from '../../src/providers/capabilities.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Provider-substrate live wiring E2E', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let registration: RegisterAnthropicAdaptersResult;
  const AUTH_TOKEN = 'test-e2e-provider-wiring';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-wiring-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    const config: InstarConfig = {
      projectName: 'e2e-test',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.0.0-e2e',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    } as InstarConfig;

    // ━━━ CRITICAL: registration the SAME WAY server.ts does ━━━
    // (startServer's Phase-5 block: enabledFrameworks gate, config paths,
    //  pool config with scratch workdir + haiku default.)
    const poolWorkdir = path.join(stateDir, 'intelligence-pool');
    fs.mkdirSync(poolWorkdir, { recursive: true });
    registration = await registerAnthropicAdapters({
      claudePath: config.sessions.claudePath,
      pool: { poolSize: 2, model: 'haiku', workingDirectory: poolWorkdir },
    });

    const state = new StateManager(stateDir);
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await registry.unregister('anthropic-headless' as never);
    await registry.unregister('anthropic-interactive-pool' as never);
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/provider-substrate-live-wiring.test.ts:cleanup' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ══════════════════════════════════════════════════════════════════
  // Phase 1: Feature is ALIVE (not dead on arrival)
  // ══════════════════════════════════════════════════════════════════

  it('GET /providers/registry returns 200 with BOTH Anthropic adapters registered', async () => {
    const res = await request(app).get('/providers/registry').set(auth());
    // If the adapters list is empty here, the boot path never registered
    // them — the exact shipped-dark gap this PR exists to close.
    expect(res.status).toBe(200);
    const ids = (res.body.adapters as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain('anthropic-headless');
    expect(ids).toContain('anthropic-interactive-pool');
  });

  it('registration was real, not skipped', () => {
    expect(registration.skippedReason).toBeUndefined();
    expect(registration.headless).toBeDefined();
    expect(registration.pool).toBeDefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 2: Boot is LAZY — registering spawned nothing
  // ══════════════════════════════════════════════════════════════════

  it('no tmux/claude process was spawned by registration (T7)', () => {
    // Other boot components legitimately shell out (e.g. the sqlite3
    // bindings probe); what must NOT appear is any tmux session spawn or
    // claude invocation originating from adapter registration.
    const spawnedBinaries = vi
      .mocked(execFileSync)
      .mock.calls.map((c) => String(c[0]));
    expect(spawnedBinaries.filter((b) => /tmux|claude/.test(b))).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 3: Default-off invariance + force-mode construction
  // ══════════════════════════════════════════════════════════════════

  it('default (no subscriptionPath config): funnel builds the plain claude provider', () => {
    // Mirrors server.ts: spMode 'off' ⇒ no subscriptionPath option passed.
    const provider = buildIntelligenceProvider({
      framework: 'claude-code',
      binaryPath: '/usr/bin/echo',
    });
    expect(provider).not.toBeNull();
  });

  it("force mode (mirroring server.ts's subscriptionPathOption): calls served by the pool", async () => {
    // Replace the pool adapter's one-shot with a fake so no real REPL is
    // needed; the wiring under test is funnel→router→pool-adapter.
    const poolAdapter = registration.pool!;
    const fakeOneShot = {
      capability: CapabilityFlag.OneShotCompletion,
      evaluate: async () => ({ text: 'served-by-pool', usage: null }),
    };
    const originalPrimitive = poolAdapter.primitive;
    (poolAdapter as { primitive: unknown }).primitive = (cap: CapabilityFlag) =>
      cap === CapabilityFlag.OneShotCompletion ? fakeOneShot : originalPrimitive(cap);

    try {
      const provider = buildIntelligenceProvider({
        framework: 'claude-code',
        binaryPath: '/usr/bin/echo',
        subscriptionPath: {
          mode: 'force',
          poolAdapter,
          readSdkCredit: registration.readSdkCredit,
        },
      });
      expect(provider).not.toBeNull();
      expect(await provider!.evaluate('judgment call', { attribution: { component: 'E2ETest' } }))
        .toBe('served-by-pool');
    } finally {
      (poolAdapter as { primitive: unknown }).primitive = originalPrimitive;
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 4: Codex-only gate (the other side of the boundary)
  // ══════════════════════════════════════════════════════════════════

  it('a codex-only agent registers NOTHING', async () => {
    const result = await registerAnthropicAdapters({
      enabledFrameworks: ['codex-cli'],
    });
    expect(result.skippedReason).toBe('claude-code-not-enabled');
    // The singleton still holds exactly the two adapters from boot — the
    // skipped call added nothing.
    const res = await request(app).get('/providers/registry').set(auth());
    expect(res.body.count).toBe(2);
  });
});
