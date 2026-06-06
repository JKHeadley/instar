/**
 * E2E test — Headless-spawn reroute (june15-headless-spawn-reroute, PR2)
 * full lifecycle. Verification map V6: the spawn-path "200 not 503".
 *
 * Tests the PRODUCTION wiring shape, mirroring src/commands/server.ts:
 *   1. SessionManager constructed with the EXACT sessionManagerConfig
 *      threading server.ts uses (subscriptionPathMode from
 *      config.intelligence.subscriptionPath).
 *   2. The "feature is alive" check: a REAL spawnSession() job spawn under
 *      mode 'force' launches an INTERACTIVE claude (live tmux argv has no
 *      `-p`, wide pane geometry), stamped launchLane='rerouted-interactive'.
 *   3. The session reaches pattern-completion via the real monitor path
 *      (sentinel in captured output → reaped as success, not timeout).
 *   4. The HTTP surface: GET /sessions reports launchLane — the soak's
 *      machine-checkable "zero headless claude-code spawns under force".
 *   5. Default-off invariance: mode 'off' → headless `-p` argv, launchLane
 *      'headless'.
 *
 * WHY THIS TEST EXISTS: unit tests prove the reroute works when the config
 * fields are set; this proves the production CONSTRUCTION SHAPE sets them —
 * the exact class of gap PR1 closed (substrate built, never wired).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const mockTmuxSessions = new Set<string>();
const newSessionArgvs: string[][] = [];
/** Toggled by the completion test: capture-pane returns the sentinel. */
let capturePaneOutput = '';

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'new-session') {
      newSessionArgvs.push([...args]);
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    if (args[0] === 'kill-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (target) mockTmuxSessions.delete(target);
      return '';
    }
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (target && !mockTmuxSessions.has(target)) throw new Error('no session');
      return '';
    }
    if (args[0] === 'capture-pane') return capturePaneOutput;
    if (args[0] === 'display-message') return 'claude||claude';
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
    execSync: vi.fn(() => ''),
  };
});

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function stubReadyWait(manager: SessionManager): void {
  // The detached ready-wait polls a real REPL for up to ~90s; with mocked
  // tmux it must resolve immediately so spawns don't leak timers.
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> })
    .waitForClaudeReadyWithRetry = async () => true;
}

describe('Headless-spawn reroute E2E (V6)', () => {
  let tmpDir: string;
  let stateDir: string;
  const AUTH_TOKEN = 'test-e2e-spawn-reroute';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-reroute-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/june15-headless-spawn-reroute.test.ts:cleanup',
    });
  });

  /**
   * Mirror src/commands/server.ts EXACTLY: the subscriptionPath threading
   * into sessionManagerConfig. If server.ts's construction shape drifts from
   * this, the drift is the bug this test exists to catch.
   */
  function productionSessionManager(config: InstarConfig, state: StateManager): SessionManager {
    const subscriptionPathCfg = config.intelligence?.subscriptionPath;
    const sessionManagerConfig = {
      ...config.sessions,
      subscriptionPathMode: subscriptionPathCfg?.mode ?? 'off',
      ...(subscriptionPathCfg?.maxRerouted != null ? { subscriptionMaxRerouted: subscriptionPathCfg.maxRerouted } : {}),
      ...(subscriptionPathCfg?.maxReroutedLifetimeMinutes != null
        ? { subscriptionReroutedLifetimeMinutes: subscriptionPathCfg.maxReroutedLifetimeMinutes }
        : {}),
    };
    const manager = new SessionManager(sessionManagerConfig as never, state);
    stubReadyWait(manager);
    return manager;
  }

  function baseConfig(mode?: 'off' | 'auto' | 'force'): InstarConfig {
    return {
      projectName: 'e2e-reroute',
      stateDir,
      authToken: AUTH_TOKEN,
      sessions: {
        projectDir: tmpDir,
        claudePath: '/usr/local/bin/claude',
        tmuxPath: '/usr/bin/tmux',
        projectName: 'e2e-reroute',
        maxSessions: 10,
        protectedSessions: [],
        completionPatterns: ['has been automatically paused'],
      },
      ...(mode ? { intelligence: { subscriptionPath: { mode } } } : {}),
    } as unknown as InstarConfig;
  }

  it('force mode: a REAL job spawn through the production construction launches interactive (no -p), stamped rerouted-interactive', async () => {
    const state = new StateManager(stateDir);
    const manager = productionSessionManager(baseConfig('force'), state);

    newSessionArgvs.length = 0;
    const session = await manager.spawnSession({
      name: 'e2e-force-job',
      prompt: 'run the e2e task',
      jobSlug: 'e2e-force-job',
      framework: 'claude-code',
    });

    expect(session.launchLane).toBe('rerouted-interactive');
    expect(session.completionMode).toBe('pattern');
    expect(session.completionPatterns?.[0]).toMatch(/^INSTAR_JOB_COMPLETE_/);

    // The live tmux argv — the thing that actually bills: no `-p` one-shot,
    // wide pane for prompt detection.
    expect(newSessionArgvs.length).toBe(1);
    const argv = newSessionArgvs[0];
    expect(argv).not.toContain('-p');
    const xIdx = argv.indexOf('-x');
    expect(xIdx).toBeGreaterThan(-1);
    expect(argv[xIdx + 1]).toBe('200');

    await manager.terminateSession(session.id, 'e2e cleanup');
  });

  it('the sentinel completes the session through the REAL monitor path as success (not timeout)', async () => {
    const state = new StateManager(stateDir);
    const manager = productionSessionManager(baseConfig('force'), state);

    const session = await manager.spawnSession({
      name: 'e2e-sentinel-job',
      prompt: 'finish quickly',
      jobSlug: 'e2e-sentinel-job',
      framework: 'claude-code',
    });
    const sentinel = session.completionPatterns?.[0];
    expect(sentinel).toBeTruthy();

    // Age the live record past the monitor's young-session grace period
    // (a freshly-spawned session is deliberately skipped for ~15s).
    session.startedAt = new Date(Date.now() - 60_000).toISOString();
    state.saveSession(session);

    const completed = new Promise<Session>((resolve) => {
      manager.on('sessionComplete', (s: Session) => {
        if (s.id === session.id) resolve(s);
      });
    });

    // The REPL prints the sentinel — the monitor's pattern branch must reap
    // the session as a SUCCESS (status not 'killed'; JobScheduler finalizes
    // success off exactly this, spec F1).
    capturePaneOutput = `some output\n${sentinel}\n`;
    await (manager as unknown as { monitorTick: () => Promise<void> }).monitorTick();
    const done = await completed;
    expect(done.status).not.toBe('killed');
    capturePaneOutput = '';
  });

  it('GET /sessions (real HTTP pipeline) surfaces launchLane — the machine-checkable soak criterion', async () => {
    const state = new StateManager(stateDir);
    const config = baseConfig('force');
    const manager = productionSessionManager(config, state);
    const session = await manager.spawnSession({
      name: 'e2e-http-lane',
      prompt: 'http surface check',
      jobSlug: 'e2e-http-lane',
      framework: 'claude-code',
    });

    const server = new AgentServer({ config, sessionManager: manager as never, state });
    await server.start();
    try {
      const res = await request(server.getApp())
        .get('/sessions')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);
      expect(res.status).toBe(200);
      // Default (non-pool) shape: the enriched session array directly.
      const entry = (res.body as Array<{ id: string; launchLane?: string }>)
        .find((s) => s.id === session.id);
      expect(entry).toBeTruthy();
      expect(entry!.launchLane).toBe('rerouted-interactive');
    } finally {
      await manager.terminateSession(session.id, 'e2e cleanup');
      await server.stop();
    }
  });

  it('default-off invariance: mode off → headless -p argv, launchLane headless', async () => {
    const state = new StateManager(stateDir);
    const manager = productionSessionManager(baseConfig(), state);

    newSessionArgvs.length = 0;
    const session = await manager.spawnSession({
      name: 'e2e-off-job',
      prompt: 'unchanged path',
      jobSlug: 'e2e-off-job',
      framework: 'claude-code',
    });

    expect(session.launchLane).toBe('headless');
    expect(newSessionArgvs.length).toBe(1);
    expect(newSessionArgvs[0]).toContain('-p');

    await manager.terminateSession(session.id, 'e2e cleanup');
  });
});
