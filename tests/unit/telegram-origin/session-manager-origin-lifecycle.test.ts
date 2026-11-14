import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmux = vi.hoisted(() => ({ sessions: new Set<string>(), calls: [] as string[][], failKill: false,
  environment: new Map<string, string>(), failEnvironment: false }));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_cmd: string, args: string[] = []) => {
    tmux.calls.push(args);
    const target = args[args.indexOf('-t') + 1]?.replace(/^=/, '').replace(/:$/, '');
    if (args[0] === 'has-session' && !tmux.sessions.has(target)) throw Object.assign(new Error('absent'), { status: 1 });
    if (args[0] === 'new-session') tmux.sessions.add(args[args.indexOf('-s') + 1]);
    if (args[0] === 'kill-session') { if (tmux.failKill) throw new Error('kill unavailable'); tmux.sessions.delete(target); }
    return '';
  }),
  execFile: vi.fn((_cmd: string, args: string[], opts: unknown, callback?: (...args: unknown[]) => void) => {
    const cb = typeof opts === 'function' ? opts : callback;
    tmux.calls.push(args);
    if (args[0] === 'show-environment' && tmux.failEnvironment) {
      if (cb) cb(Object.assign(new Error('tmux unavailable'), { code: 'ETIMEDOUT' }));
      return;
    }
    const key = args.at(-1)!;
    if (cb) cb(null, { stdout: args[0] === 'show-environment' && tmux.environment.has(key)
      ? `${key}=${tmux.environment.get(key)}\n` : '', stderr: '' });
  }), execSync: vi.fn(() => ''), spawn: vi.fn(),
}));
import { SessionManager } from '../../../src/core/SessionManager.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import type { SessionManagerConfig } from '../../../src/core/types.js';
import { captureOriginHookSettings, originHookSettingsDigest } from '../../../src/messaging/telegram-origin/OriginNativeHookProof.js';

describe('SessionManager origin lifecycle production callback wiring', () => {
  let dir: string; let state: StateManager; let manager: SessionManager; let registry: OriginSessionRegistry;
  let bindNative: ReturnType<typeof vi.fn>; let claudePath: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-session-manager-'));
    fs.mkdirSync(path.join(dir, 'state')); state = new StateManager(path.join(dir, 'state'));
    // Process execution is mocked, but binary discovery uses the real filesystem.
    // Keep that dependency in the fixture instead of requiring a host CLI install.
    claudePath = path.join(dir, 'claude');
    fs.writeFileSync(claudePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const config: SessionManagerConfig = { tmuxPath: '/usr/bin/tmux', claudePath,
      projectDir: dir, maxSessions: 10, protectedSessions: ['protected'], completionPatterns: [], framework: 'claude-code', subscriptionPathMode: 'off' };
    manager = new SessionManager(config, state);
    registry = new OriginSessionRegistry({ stateDir: path.join(dir, 'state'), agentId: 'agent', machineId: 'host',
      isSessionLive: b => state.listSessions().some(s => s.id === b.sessionId && s.status === 'running') });
    await registry.initialize(); bindNative = vi.fn();
    manager.setOriginLifecycle({ issue: launch => registry.issue(launch), bindNative,
      revoke: sessionId => registry.revoke(sessionId) });
    vi.spyOn(manager as any, 'waitForClaudeReadyWithRetry').mockResolvedValue(true);
    vi.spyOn(manager as any, 'injectAfterReady').mockResolvedValue(undefined);
    tmux.sessions.clear(); tmux.calls = []; tmux.failKill = false; tmux.environment.clear(); tmux.failEnvironment = false;
  });
  afterEach(async () => {
    manager.stopMonitoring();
    // Drain any asynchronous verifier persistence before removing the fixture tree.
    await registry.revoke('fixture-drain');
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'origin-session-manager-test-cleanup' });
    vi.restoreAllMocks();
  });
  function launchedToken(): string {
    const args = tmux.calls.find(args => args[0] === 'new-session')!;
    expect(args).toBeDefined();
    return args.find(arg => arg.startsWith('INSTAR_ORIGIN_TOKEN='))!.split('=')[1];
  }
  it('captures hook registration only before native launch, never when re-enrolling old in-memory matchers', async () => {
    const file = path.join(dir, '.claude/settings.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
    const settings = (matcher: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ command: 'node .instar/hooks/instar/telegram-origin-guard.js' }] }] } });
    fs.writeFileSync(file, settings('Bash'));
    const old = await manager.spawnSession({ name: 'old-matcher', prompt: 'fixture' });
    expect(registry.getBinding(old.id)?.launchHookSettingsDigest).toBe(originHookSettingsDigest(settings('Bash')));
    fs.writeFileSync(file, settings('*'));
    expect(registry.getBinding(old.id)?.launchHookSettingsDigest).not.toBe(await captureOriginHookSettings(dir, 'claude-code'));
    await manager.enrollExistingOriginSessions();
    expect(registry.getBinding(old.id)?.launchHookSettingsDigest).toBeUndefined();
    const replacement = await manager.spawnSession({ name: 'new-matcher', prompt: 'fixture' });
    expect(registry.getBinding(replacement.id)?.launchHookSettingsDigest).toBe(originHookSettingsDigest(settings('*')));
  });
  it.each(['headless', 'interactive', 'triage', 'rerouted'] as const)('%s injects its own persisted token bound to its actual launch', async lane => {
    if (lane === 'headless') await manager.spawnSession({ name: 'headless', prompt: 'fixture', model: 'sonnet' });
    if (lane === 'interactive') await manager.spawnInteractiveSession(undefined, 'interactive');
    if (lane === 'triage') await manager.spawnTriageSession('triage', { allowedTools: ['Read'], permissionMode: 'dontAsk' });
    if (lane === 'rerouted') await (manager as any).spawnReroutedInteractive({ sessionId: 'rerouted-id', tmuxSession: 'rerouted',
      options: { name: 'rerouted', prompt: 'fixture' }, binaryPath: claudePath, launchModel: 'sonnet',
      resolvedCwd: dir, workTreeFencingToken: null, shimDir: null });
    const verification = registry.verify(launchedToken());
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.binding).toMatchObject({ agentId: 'agent', machineId: 'host', harnessId: 'claude-code', projectDir: dir });
      expect(state.getSession(verification.binding.sessionId)?.status).toBe('running');
    }
  });
  it('refuses triage before launch when its configured binary is missing', async () => {
    fs.renameSync(claudePath, `${claudePath}.unavailable`);
    await expect(manager.spawnTriageSession('missing-binary', {
      allowedTools: ['Read'], permissionMode: 'dontAsk',
    })).rejects.toThrow('triage-session-no-claude-binary');
    expect(tmux.calls.some(args => args[0] === 'new-session')).toBe(false);
  });
  it('does not revoke a live session on a failed manual kill; success revokes before returning', async () => {
    const session = await manager.spawnSession({ name: 'kill-control', prompt: 'fixture' });
    const token = launchedToken();
    tmux.failKill = true;
    expect(manager.killSession(session.id)).toBe(false);
    expect(registry.verify(token).ok).toBe(true);
    tmux.failKill = false;
    expect(manager.killSession(session.id)).toBe(true);
    expect(registry.verify(token).ok).toBe(false);
  });
  it('re-enrolls a surviving nondefault Claude account and observes its native model after restart', async () => {
    const session = await manager.spawnSession({ name: 'account-home', prompt: 'fixture', model: 'sonnet' });
    const oldToken = launchedToken();
    const nativeId = '11111111-1111-4111-8111-111111111111';
    manager.setClaudeSessionId(session.id, nativeId);
    const accountHome = path.join(dir, 'pooled account');
    const transcript = path.join(accountHome, 'projects', dir.replace(/[\\/.]/g, '-'), `${nativeId}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.copyFileSync('tests/fixtures/telegram-origin-native/claude.jsonl', transcript);
    tmux.environment.set('CLAUDE_CONFIG_DIR', accountHome);
    const observer = new RuntimeOriginObserver({ homeDir: path.join(dir, 'wrong-default-home') });
    const restarted = new OriginSessionRegistry({ stateDir: path.join(dir, 'state'), agentId: 'agent', machineId: 'host',
      isSessionLive: b => state.getSession(b.sessionId)?.status === 'running' });
    await restarted.initialize();
    manager.setOriginLifecycle({ issue: async launch => {
      const token = await restarted.issue(launch); observer.track(restarted.getBinding(launch.sessionId)!); return token;
    }, bindNative, revoke: id => restarted.revoke(id) });
    try {
      expect(await manager.enrollExistingOriginSessions()).toEqual({ enrolled: 1, unavailable: [] });
      expect(restarted.getBinding(session.id)?.configHome).toBe(accountHome);
      expect(restarted.verify(oldToken).ok).toBe(false);
      const publish = tmux.calls.find(args => args[0] === 'set-environment' && args[3] === 'INSTAR_ORIGIN_TOKEN');
      expect(publish).toBeDefined();
      expect(restarted.verify(publish![4]).ok).toBe(true);
      await observer.refresh(session.id);
      expect(observer.get(session.id)?.model).toMatchObject({ status: 'observed', value: 'claude-native-second' });
    } finally { observer.stop(); await restarted.revoke(session.id); }
  });
  it.each([['codex-cli', 'CODEX_HOME'], ['gemini-cli', 'GEMINI_CLI_HOME'], ['grok-build', 'GROK_HOME']] as const)(
    're-enrollment preserves the running %s home', async (framework, key) => {
      const session = await manager.spawnSession({ name: 'account-home', prompt: 'fixture' });
      state.saveSession({ ...session, framework });
      const accountHome = path.join(dir, framework);
      tmux.environment.set(key, accountHome);
      expect(await manager.enrollExistingOriginSessions()).toEqual({ enrolled: 1, unavailable: [] });
      expect(registry.getBinding(session.id)?.configHome).toBe(accountHome);
    });
  it('holds enrollment when the live config home lookup fails instead of adopting server defaults', async () => {
    const session = await manager.spawnSession({ name: 'account-home', prompt: 'fixture' });
    tmux.failEnvironment = true;
    expect(await manager.enrollExistingOriginSessions()).toEqual({ enrolled: 0, unavailable: [session.id] });
    expect(registry.getBinding(session.id)).toBeUndefined();
    expect(tmux.calls.some(args => args[0] === 'set-environment')).toBe(false);
  });
  // Live 2026-11-12: worktree sessions re-enrolled after a restart were bound to the agent home,
  // because the headless record never kept its spawn tree; the transcript was never found.
  it('a headless session keeps its spawn tree, and re-enrollment binds that tree', async () => {
    const tree = path.join(dir, '.worktrees', 'topic-42');
    fs.mkdirSync(tree, { recursive: true });
    const session = await manager.spawnSession({ name: 'tree', prompt: 'fixture', cwd: tree });
    expect(state.getSession(session.id)?.cwd).toBe(tree);
    expect(registry.getBinding(session.id)?.projectDir).toBe(tree);
    expect(await manager.enrollExistingOriginSessions()).toEqual({ enrolled: 1, unavailable: [] });
    expect(registry.getBinding(session.id)?.projectDir).toBe(tree);
  });
  // Live 2026-11-12: a first reply 13 s after spawn read "native-session-unbound" (no hook yet).
  it('resolves an unreported Claude session id from Claude Code\'s own per-process record', async () => {
    const session = await manager.spawnSession({ name: 'first-reply', prompt: 'fixture' });
    const home = path.join(dir, 'claude-home');
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    const nativeId = '44444444-4444-4444-8444-444444444444';
    fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: nativeId, tmux: `${session.tmuxSession}:@1.%1`, startedAt: Date.now() }));
    vi.spyOn(manager, 'configHomeForSession').mockReturnValue(home);
    expect(manager.resolveOriginNativeSession(session.id)).toBe(nativeId);
    expect(state.getSession(session.id)?.claudeSessionId).toBe(nativeId);
    expect(bindNative).toHaveBeenLastCalledWith(session.id, nativeId);
    // Already known: re-tells the observer without another lookup.
    bindNative.mockClear();
    expect(manager.resolveOriginNativeSession(session.id)).toBe(nativeId);
    expect(bindNative).toHaveBeenCalledWith(session.id, nativeId);
    expect(manager.resolveOriginNativeSession('not-a-session')).toBeNull();
  });
  it('native registration is scoped to an existing running Instar session', async () => {
    const session = await manager.spawnSession({ name: 'bind-control', prompt: 'fixture' });
    manager.setClaudeSessionId('foreign', 'native-wrong');
    expect(bindNative).not.toHaveBeenCalled();
    manager.setClaudeSessionId(session.id, 'native-first');
    manager.setClaudeSessionId(session.id, 'native-second');
    expect(bindNative.mock.calls).toEqual([[session.id, 'native-first'], [session.id, 'native-second']]);
  });
  it('mint failure prevents spawn without logging or inheriting a parent token', async () => {
    manager.setOriginLifecycle({ issue: async () => { throw new Error('registry unavailable'); }, bindNative, revoke: () => undefined });
    await expect(manager.spawnSession({ name: 'failed', prompt: 'fixture' })).rejects.toThrow('registry unavailable');
    expect(tmux.calls.some(args => args[0] === 'new-session')).toBe(false);
  });
});
