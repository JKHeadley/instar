/**
 * Headless-spawn reroute (june15-headless-spawn-reroute, PR2 — Part 1 core).
 *
 * Verifies the control-flow fork in SessionManager.spawnSession's claude-code
 * headless branch: when intelligence.subscriptionPath.mode is 'force' (or 'auto'
 * under SDK-pot pressure) a `claude -p` one-shot is rerouted onto the interactive
 * (subscription) lane so it stops billing the Agent SDK pot after 2026-06-15.
 *
 * The verification map (spec §"Verification map" V1–V5 + the ops gates):
 *  - V1: mode off/unset → headless argv byte-for-byte (the `-p` one-shot).
 *  - V2: force + claude-code → no `-p`, --session-id carried, spliced
 *        --strict-mcp-config flags, and -x 200 -y 50 in the tmux args.
 *  - V3: completionMode both sides (per-session pattern vs exit semantics).
 *  - V4: rerouted spawn with sessionId pins --session-id (A2A continuity).
 *  - V5: codex-cli/gemini under force → headless argv untouched.
 *  - cap / lifetime-kill / rawInject sanitizer / triggerJob double-run /
 *    boot reconciliation.
 *
 * Mocking mirrors session-manager-terminate.test.ts: node:child_process is
 * stubbed with an argv-capturing tmux handle; the background ready-wait is
 * stubbed per-instance so spawnSession's detached inject completes immediately.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
/** Every `new-session` argv captured, in call order (for argv-pin assertions). */
const newSessionArgvs: string[][] = [];
/** Every send-keys `-l` literal payload captured (for the sanitizer assertion). */
const sentLiterals: string[] = [];

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'send-keys' && args.includes('-l')) {
      sentLiterals.push(args[args.indexOf('-l') + 1]);
      return '';
    }
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
    if (args[0] === 'display-message') {
      // pane_current_command — report a live claude so isSessionAlive passes.
      return 'claude||claude';
    }
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
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

/** Helper: the newest captured new-session argv. */
function lastNewSessionArgv(): string[] {
  return newSessionArgvs[newSessionArgvs.length - 1];
}

/** Helper: the argv AFTER the tmux env block (everything from the binary path on). */
function launchArgvFrom(argv: string[], binary: string): string[] {
  const idx = argv.indexOf(binary);
  return idx >= 0 ? argv.slice(idx) : [];
}

const CLAUDE = '/usr/local/bin/claude';

function makeManager(opts: {
  mode?: 'off' | 'auto' | 'force';
  maxRerouted?: number;
  framework?: 'claude-code' | 'codex-cli' | 'gemini-cli';
  credit?: () => Promise<{ remainingUsd: number; totalUsd: number } | null>;
}, tmpDir: string): { manager: SessionManager; state: StateManager } {
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const state = new StateManager(stateDir);
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: CLAUDE,
    frameworkBinaryPaths: { 'claude-code': CLAUDE, 'codex-cli': '/usr/local/bin/codex', 'gemini-cli': '/usr/local/bin/gemini' },
    projectName: 'proj',
    projectDir: tmpDir,
    maxSessions: 10,
    protectedSessions: [],
    completionPatterns: ['has been automatically paused'],
    ...(opts.framework ? { framework: opts.framework } : {}),
    ...(opts.mode ? { subscriptionPathMode: opts.mode } : {}),
    ...(opts.maxRerouted != null ? { subscriptionMaxRerouted: opts.maxRerouted } : {}),
  };
  const manager = new SessionManager(config, state);
  // Stub the background ready-wait so the detached injectAfterReady completes
  // immediately (otherwise it polls for ~90s). The tmux argv is captured
  // synchronously at new-session, so this never affects the pin assertions.
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> })
    .waitForClaudeReadyWithRetry = async () => true;
  // Deterministic reroute gate regardless of the host machine's live memory
  // state: the gate legitimately refuses force-mode spawns when the REAL host
  // is under pressure, which made this suite fail on loaded dev machines while
  // passing in CI. These tests assert the reroute logic, not host pressure.
  (manager as unknown as { currentMemoryPressure: () => string })
    .currentMemoryPressure = () => 'normal';
  if (opts.credit) {
    manager.setSdkCreditReader(opts.credit as never);
  }
  return { manager, state };
}

describe('headless-spawn reroute', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reroute-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/headless-spawn-reroute.test.ts' });
  });

  // ── V1: mode off/unset → byte-for-byte today's headless argv ──
  it('V1: mode unset → claude-code spawn is the headless `-p` one-shot (byte-for-byte)', async () => {
    const { manager, state } = makeManager({}, tmpDir);
    const s = await manager.spawnSession({ name: 'job-a', prompt: 'do the thing', model: 'haiku' });

    const launch = launchArgvFrom(lastNewSessionArgv(), CLAUDE);
    // The exact headless argv: binary, --dangerously-skip-permissions, --model haiku, -p, prompt
    expect(launch).toEqual([CLAUDE, '--dangerously-skip-permissions', '--model', 'haiku', '-p', 'do the thing']);
    // Lane stamped headless; completionMode 'exit' (today's behavior).
    const saved = state.getSession(s.id)!;
    expect(saved.launchLane).toBe('headless');
    expect(saved.completionMode).toBe('exit');
    expect(saved.completionPatterns).toBeUndefined();
    expect(saved.maxLifetimeMinutes).toBeUndefined();
  });

  it('V1: mode off → identical headless argv (no reroute, no -x/-y interactive geometry)', async () => {
    const { manager } = makeManager({ mode: 'off' }, tmpDir);
    await manager.spawnSession({ name: 'job-off', prompt: 'p' });
    const argv = lastNewSessionArgv();
    expect(argv).toContain('-p');
    // headless tmux block does NOT set the wide interactive pane geometry.
    expect(argv).not.toContain('200');
    expect(argv).not.toContain('50');
  });

  // ── V2: force + claude-code → interactive lane, no -p ──
  it('V2: force + claude-code → no `-p`, carries --session-id, splices --strict-mcp-config, -x 200 -y 50', async () => {
    const { manager, state } = makeManager({ mode: 'force' }, tmpDir);
    const s = await manager.spawnSession({
      name: 'job-force',
      prompt: 'rerouted task',
      model: 'haiku',
      sessionId: 'uuid-1234',
      disableProjectMcp: true,
      allowedTools: ['Read', 'Bash'],
    });

    const argv = lastNewSessionArgv();
    const launch = launchArgvFrom(argv, CLAUDE);
    // Interactive lane: NO `-p` one-shot positional.
    expect(launch).not.toContain('-p');
    // Interactive launch opens at the REPL with skip-permissions.
    expect(launch).toContain('--dangerously-skip-permissions');
    // A2A continuity: --session-id pinned (carried over).
    expect(launch).toContain('--session-id');
    expect(launch).toContain('uuid-1234');
    // Load-bearing no-project-MCP boot (S3/F4): the strict-mcp flags are spliced.
    expect(launch).toContain('--strict-mcp-config');
    expect(launch).toContain('--mcp-config');
    expect(launch).toContain('{"mcpServers":{}}');
    // Per-job tool allowlist spliced too.
    expect(launch).toContain('--allowedTools');
    expect(launch).toContain('Read,Bash');
    // Wide pane geometry (F6) — present in the tmux env block.
    const xIdx = argv.indexOf('-x');
    expect(xIdx).toBeGreaterThanOrEqual(0);
    expect(argv[xIdx + 1]).toBe('200');
    const yIdx = argv.indexOf('-y');
    expect(yIdx).toBeGreaterThanOrEqual(0);
    expect(argv[yIdx + 1]).toBe('50');

    // Session record stamped with the reroute completion contract.
    const saved = state.getSession(s.id)!;
    expect(saved.launchLane).toBe('rerouted-interactive');
    expect(saved.completionMode).toBe('pattern');
    expect(saved.completionPatterns).toHaveLength(1);
    expect(saved.completionPatterns![0]).toMatch(/^INSTAR_JOB_COMPLETE_/);
    expect(saved.maxLifetimeMinutes).toBe(45); // default
  });

  it('V2: force without disableProjectMcp → no strict-mcp splice (both sides pinned)', async () => {
    const { manager } = makeManager({ mode: 'force' }, tmpDir);
    await manager.spawnSession({ name: 'job-no-mcp-flag', prompt: 'p' });
    const launch = launchArgvFrom(lastNewSessionArgv(), CLAUDE);
    expect(launch).not.toContain('-p'); // still rerouted (interactive)
    expect(launch).not.toContain('--strict-mcp-config');
    expect(launch).not.toContain('--allowedTools');
  });

  it('V2: rerouted prompt gets the completion sentinel appended', async () => {
    const { manager } = makeManager({ mode: 'force' }, tmpDir);
    const captured: string[] = [];
    (manager as unknown as { injectMessage: (t: string, text: string) => boolean }).injectMessage =
      (_t, text) => { captured.push(text); return true; };
    const s = await manager.spawnSession({ name: 'job-sentinel', prompt: 'ORIGINAL PROMPT' });
    // Allow the detached injectAfterReady to run (it has a 1000ms stabilization
    // delay before injecting — see injectAfterReady).
    await new Promise((r) => setTimeout(r, 1200));
    const sentinel = `INSTAR_JOB_COMPLETE_${s.id.slice(-8)}`;
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('ORIGINAL PROMPT');
    expect(captured[0]).toContain(sentinel);
    expect(captured[0].trimEnd().endsWith(sentinel)).toBe(true);
  });

  // ── V4: A2A continuity — resumeSessionId path ──
  it('V4: rerouted spawn with resumeSessionId pins --resume (continuity)', async () => {
    const { manager } = makeManager({ mode: 'force' }, tmpDir);
    await manager.spawnSession({ name: 'job-resume', prompt: 'p', resumeSessionId: 'resume-uuid-9' });
    const launch = launchArgvFrom(lastNewSessionArgv(), CLAUDE);
    expect(launch).toContain('--resume');
    expect(launch).toContain('resume-uuid-9');
    expect(launch).not.toContain('-p');
  });

  // ── V5: non-claude frameworks untouched under force ──
  it('V5: codex-cli under force → headless argv untouched (no reroute)', async () => {
    const CODEX = '/usr/local/bin/codex';
    const { manager, state } = makeManager({ mode: 'force', framework: 'codex-cli' }, tmpDir);
    const s = await manager.spawnSession({ name: 'job-codex', prompt: 'codex task' });
    const launch = launchArgvFrom(lastNewSessionArgv(), CODEX);
    // Codex headless shape: exec --json … prompt. Reroute is Anthropic-only.
    expect(launch).toContain('exec');
    expect(launch).toContain('--json');
    expect(launch[launch.length - 1]).toBe('codex task');
    // No interactive geometry, lane is headless.
    expect(lastNewSessionArgv()).not.toContain('200');
    expect(state.getSession(s.id)!.launchLane).toBe('headless');
  });

  it('V5: gemini-cli under force → headless argv untouched (no reroute)', async () => {
    const GEMINI = '/usr/local/bin/gemini';
    const { manager } = makeManager({ mode: 'force', framework: 'gemini-cli' }, tmpDir);
    await manager.spawnSession({ name: 'job-gem', prompt: 'gem task' });
    const launch = launchArgvFrom(lastNewSessionArgv(), GEMINI);
    expect(launch).toContain('-p');
    expect(launch[launch.length - 1]).toBe('gem task');
  });

  // ── auto mode — credit-driven decision ──
  it('auto: SDK pot healthy → headless (drain the prepaid pot first)', async () => {
    const { manager, state } = makeManager(
      { mode: 'auto', credit: async () => ({ remainingUsd: 100, totalUsd: 100 }) },
      tmpDir,
    );
    const s = await manager.spawnSession({ name: 'job-auto-healthy', prompt: 'p' });
    expect(launchArgvFrom(lastNewSessionArgv(), CLAUDE)).toContain('-p');
    expect(state.getSession(s.id)!.launchLane).toBe('headless');
  });

  it('auto: SDK pot below margin → reroute to interactive lane', async () => {
    const { manager, state } = makeManager(
      { mode: 'auto', credit: async () => ({ remainingUsd: 1, totalUsd: 100 }) },
      tmpDir,
    );
    const s = await manager.spawnSession({ name: 'job-auto-low', prompt: 'p' });
    expect(launchArgvFrom(lastNewSessionArgv(), CLAUDE)).not.toContain('-p');
    expect(state.getSession(s.id)!.launchLane).toBe('rerouted-interactive');
  });

  it('auto: unknown credit (null) → subscription floor (reroute)', async () => {
    const { manager, state } = makeManager({ mode: 'auto', credit: async () => null }, tmpDir);
    const s = await manager.spawnSession({ name: 'job-auto-null', prompt: 'p' });
    expect(state.getSession(s.id)!.launchLane).toBe('rerouted-interactive');
  });

  // ── cap gate (S1/O2) ──
  it('cap: 4th concurrent reroute under auto falls back headless + reports degradation', async () => {
    const { DegradationReporter } = await import('../../src/monitoring/DegradationReporter.js');
    const reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report');
    const { manager, state } = makeManager(
      { mode: 'auto', maxRerouted: 3, credit: async () => null }, // null → reroute
      tmpDir,
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await manager.spawnSession({ name: `job-cap-${i}`, prompt: 'p' });
      ids.push(s.id);
    }
    // First 3 rerouted.
    for (const id of ids) expect(state.getSession(id)!.launchLane).toBe('rerouted-interactive');
    // 4th hits the cap → falls back to headless.
    const fourth = await manager.spawnSession({ name: 'job-cap-3', prompt: 'p' });
    expect(state.getSession(fourth.id)!.launchLane).toBe('headless');
    expect(launchArgvFrom(lastNewSessionArgv(), CLAUDE)).toContain('-p');
    expect(reportSpy).toHaveBeenCalled();
    reportSpy.mockRestore();
  });

  it('cap: under force, exceeding the cap THROWS (no headless fallback)', async () => {
    const { manager } = makeManager({ mode: 'force', maxRerouted: 1 }, tmpDir);
    await manager.spawnSession({ name: 'job-force-1', prompt: 'p' });
    await expect(
      manager.spawnSession({ name: 'job-force-2', prompt: 'p' }),
    ).rejects.toThrow(/Reroute refused \(force-mode\)/);
  });
});

// ── V3: completionMode decision boundary (per-session detection) ──
describe('detectSessionCompletion (V3 decision boundary)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reroute-detect-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/headless-spawn-reroute.test.ts' });
  });

  it("'pattern' session: own sentinel in captured output → detected", () => {
    const { manager } = makeManager({}, tmpDir);
    (manager as unknown as { captureOutput: () => string }).captureOutput =
      () => 'working...\nINSTAR_JOB_COMPLETE_abcd1234\n';
    const session = {
      id: 'x', name: 'x', status: 'running' as const, tmuxSession: 'proj-x',
      startedAt: new Date().toISOString(), completionMode: 'pattern' as const,
      completionPatterns: ['INSTAR_JOB_COMPLETE_abcd1234'],
    };
    expect(manager.detectSessionCompletion(session)).toBe(true);
  });

  it("'pattern' session: sentinel NOT present → not detected", () => {
    const { manager } = makeManager({}, tmpDir);
    (manager as unknown as { captureOutput: () => string }).captureOutput =
      () => 'still working, no marker yet\n';
    const session = {
      id: 'y', name: 'y', status: 'running' as const, tmuxSession: 'proj-y',
      startedAt: new Date().toISOString(), completionMode: 'pattern' as const,
      completionPatterns: ['INSTAR_JOB_COMPLETE_zzzz9999'],
    };
    expect(manager.detectSessionCompletion(session)).toBe(false);
  });

  it('global detectCompletion still uses config patterns (exit-lane untouched)', () => {
    const { manager } = makeManager({}, tmpDir);
    (manager as unknown as { captureOutput: () => string }).captureOutput =
      () => 'session has been automatically paused\n';
    // The default lane relies on the global config patterns, unchanged.
    expect(manager.detectCompletion('proj-z')).toBe(true);
  });
});

// ── Monitor branch: sentinel → success terminate; lifetime → timeout kill ──
describe('monitorTick rerouted-interactive branch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reroute-monitor-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/headless-spawn-reroute.test.ts' });
  });

  it('sentinel match → terminates via the SUCCESS path (status completed, not killed)', async () => {
    const { manager, state } = makeManager({}, tmpDir);
    // Persist a rerouted session old enough to clear the 15s grace period.
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    state.saveSession({
      id: 'rr-1', name: 'rr-1', status: 'running', jobSlug: 'my-job', tmuxSession: 'proj-rr-1',
      startedAt, framework: 'claude-code',
      launchLane: 'rerouted-interactive', completionMode: 'pattern',
      completionPatterns: ['INSTAR_JOB_COMPLETE_deadbeef'], maxLifetimeMinutes: 45,
    });
    mockTmuxSessions.add('proj-rr-1');
    // Stub the monitor's reads: alive + captured output contains the sentinel.
    (manager as unknown as { isSessionAliveAsync: () => Promise<boolean> }).isSessionAliveAsync = async () => true;
    (manager as unknown as { recordBuildContext: () => void }).recordBuildContext = () => {};
    (manager as unknown as { captureOutput: () => string }).captureOutput =
      () => 'done\nINSTAR_JOB_COMPLETE_deadbeef\n';

    let completedStatus: string | undefined;
    manager.on('sessionComplete', (s) => { completedStatus = s.status; });
    await (manager as unknown as { monitorTick: () => Promise<void> }).monitorTick();

    const saved = state.getSession('rr-1')!;
    expect(saved.status).toBe('completed'); // NOT 'killed' → JobScheduler records success
    expect(saved.endedReason).toBe('sentinel-complete');
    expect(completedStatus).toBe('completed');
  });

  it('hard lifetime exceeded without sentinel → killed (timeout) + degradation', async () => {
    const { DegradationReporter } = await import('../../src/monitoring/DegradationReporter.js');
    const reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report');
    const { manager, state } = makeManager({}, tmpDir);
    // Started 50 min ago; lifetime cap 45 → over.
    const startedAt = new Date(Date.now() - 50 * 60_000).toISOString();
    state.saveSession({
      id: 'rr-2', name: 'rr-2', status: 'running', jobSlug: 'my-job-2', tmuxSession: 'proj-rr-2',
      startedAt, framework: 'claude-code',
      launchLane: 'rerouted-interactive', completionMode: 'pattern',
      completionPatterns: ['INSTAR_JOB_COMPLETE_never'], maxLifetimeMinutes: 45,
    });
    mockTmuxSessions.add('proj-rr-2');
    (manager as unknown as { isSessionAliveAsync: () => Promise<boolean> }).isSessionAliveAsync = async () => true;
    (manager as unknown as { recordBuildContext: () => void }).recordBuildContext = () => {};
    // No sentinel in the output → lifetime cap fires.
    (manager as unknown as { captureOutput: () => string }).captureOutput = () => 'still grinding away\n';

    await (manager as unknown as { monitorTick: () => Promise<void> }).monitorTick();

    const saved = state.getSession('rr-2')!;
    expect(saved.status).toBe('killed'); // killed → JobScheduler records 'timeout'
    expect(saved.endedReason).toBe('rerouted-lifetime');
    expect(reportSpy).toHaveBeenCalled();
    reportSpy.mockRestore();
  });

  it('under lifetime, no sentinel → left running (re-check next tick)', async () => {
    const { manager, state } = makeManager({}, tmpDir);
    const startedAt = new Date(Date.now() - 60_000).toISOString(); // 1 min old
    state.saveSession({
      id: 'rr-3', name: 'rr-3', status: 'running', tmuxSession: 'proj-rr-3',
      startedAt, framework: 'claude-code',
      launchLane: 'rerouted-interactive', completionMode: 'pattern',
      completionPatterns: ['INSTAR_JOB_COMPLETE_pending'], maxLifetimeMinutes: 45,
    });
    mockTmuxSessions.add('proj-rr-3');
    (manager as unknown as { isSessionAliveAsync: () => Promise<boolean> }).isSessionAliveAsync = async () => true;
    (manager as unknown as { recordBuildContext: () => void }).recordBuildContext = () => {};
    (manager as unknown as { captureOutput: () => string }).captureOutput = () => 'working\n';

    await (manager as unknown as { monitorTick: () => Promise<void> }).monitorTick();
    expect(state.getSession('rr-3')!.status).toBe('running');
  });
});

// ── Boot reconciliation: surviving rerouted job session is killed (O3) ──
describe('purgeDeadSessions — rerouted-job boot reconciliation', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reroute-boot-'));
    mockTmuxSessions.clear();
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/headless-spawn-reroute.test.ts' });
  });

  /** Fake oracle reporting every probed session 'alive'. */
  function aliveOracle() {
    return {
      probeAll: async (names: string[]) => {
        const m = new Map<string, { liveness: 'alive' | 'dead' | 'indeterminate'; reason: string }>();
        for (const n of names) m.set(n, { liveness: 'alive', reason: 'test-alive' });
        return m;
      },
    };
  }

  it('kills a surviving rerouted job session at boot (adopt-or-kill = kill)', async () => {
    const { manager, state } = makeManager({}, tmpDir);
    (manager as unknown as { setLivenessOracle: (o: unknown) => void }).setLivenessOracle(aliveOracle());

    // A rerouted JOB session that survived a restart — alive in tmux, but its
    // run-tracking is gone. It must be killed so the job reruns cleanly.
    state.saveSession({
      id: 'boot-rr', name: 'boot-rr', status: 'running', jobSlug: 'nightly-report',
      tmuxSession: 'proj-boot-rr', startedAt: new Date().toISOString(),
      framework: 'claude-code', launchLane: 'rerouted-interactive', completionMode: 'pattern',
    });
    mockTmuxSessions.add('proj-boot-rr');

    await manager.purgeDeadSessions();
    const saved = state.getSession('boot-rr')!;
    expect(saved.status).toBe('killed');
    expect(saved.endedReason).toBe('boot-reconcile-rerouted-job');
  });

  it('does NOT kill an alive rerouted session with NO jobSlug (A2A — left intact)', async () => {
    const { manager, state } = makeManager({}, tmpDir);
    (manager as unknown as { setLivenessOracle: (o: unknown) => void }).setLivenessOracle(aliveOracle());
    state.saveSession({
      id: 'boot-a2a', name: 'boot-a2a', status: 'running',
      tmuxSession: 'proj-boot-a2a', startedAt: new Date().toISOString(),
      framework: 'claude-code', launchLane: 'rerouted-interactive', completionMode: 'pattern',
    });
    mockTmuxSessions.add('proj-boot-a2a');

    await manager.purgeDeadSessions();
    expect(state.getSession('boot-a2a')!.status).toBe('running');
  });

  it('does NOT kill an alive HEADLESS job session at boot (only rerouted are reconciled)', async () => {
    const { manager, state } = makeManager({}, tmpDir);
    (manager as unknown as { setLivenessOracle: (o: unknown) => void }).setLivenessOracle(aliveOracle());
    state.saveSession({
      id: 'boot-hl', name: 'boot-hl', status: 'running', jobSlug: 'some-job',
      tmuxSession: 'proj-boot-hl', startedAt: new Date().toISOString(),
      framework: 'claude-code', launchLane: 'headless', completionMode: 'exit',
    });
    mockTmuxSessions.add('proj-boot-hl');

    await manager.purgeDeadSessions();
    expect(state.getSession('boot-hl')!.status).toBe('running');
  });
});

// ── rawInject paste-escape sanitizer (S2) ──
describe('rawInject sanitizer (S2 paste-escape)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reroute-sani-'));
    mockTmuxSessions.clear();
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/headless-spawn-reroute.test.ts' });
  });

  it('strips embedded bracketed-paste markers from prompt content', () => {
    const { manager } = makeManager({}, tmpDir);
    const tmux = 'proj-sani';
    mockTmuxSessions.add(tmux);
    sentLiterals.length = 0;
    // Single-line text with an embedded paste-end forge attempt.
    const malicious = 'hello\x1b[201~ extra turn';
    (manager as unknown as { rawInject: (t: string, text: string) => boolean }).rawInject(tmux, malicious);
    // The literal `-l` text sent to tmux must have the \x1b[20X~ sequences stripped.
    expect(sentLiterals.length).toBeGreaterThan(0);
    for (const t of sentLiterals) {
      expect(t).not.toMatch(/\x1b\[20[01]~/);
    }
    expect(sentLiterals.join('')).toContain('hello extra turn');
  });
});
