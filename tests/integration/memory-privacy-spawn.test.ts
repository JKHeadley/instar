/**
 * Integration — memory privacy through the real SessionManager spawn path.
 * Spec: docs/specs/memory-privacy.md. tmux is mocked; the filesystem, the policy
 * and the audience decision are real. Made-up people only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const sessions = new Set<string>();
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'has-session') {
      const t = (args[args.indexOf('-t') + 1] ?? '').replace(/^=/, '').replace(/:$/, '');
      if (!sessions.has(t)) throw new Error('no session');
      return '';
    }
    if (args[0] === 'new-session') {
      const s = args[args.indexOf('-s') + 1];
      if (s) sessions.add(s);
      return '';
    }
    if (args[0] === 'kill-session') {
      sessions.delete((args[args.indexOf('-t') + 1] ?? '').replace(/^=/, '').replace(/:$/, ''));
      return '';
    }
    return '';
  }),
  execFile: vi.fn().mockImplementation((_c: string, _a: string[], _o: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
    const done = typeof _o === 'function' ? (_o as typeof cb) : cb;
    done?.(null, { stdout: '' });
  }),
}));

import { execFileSync } from 'node:child_process';
import { MemoryPrivacyUnavailableError, SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { wireMemoryPrivacy } from '../../src/users/wireMemoryPrivacy.js';

describe('Memory privacy — real spawn path (integration)', () => {
  let home: string;
  let projectDir: string;
  let manager: SessionManager;
  let origHome: string | undefined;
  let messaging: Array<{ type: string; config: Record<string, unknown> }>;
  let sandbox: boolean;

  const lastLaunch = (): string[] => {
    const calls = vi.mocked(execFileSync).mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return (calls[calls.length - 1]?.[1] as string[]) ?? [];
  };
  const envOf = (args: string[], key: string) => args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);

  async function wire() {
    const wiring = wireMemoryPrivacy({
      projectDir, stateDir: path.join(projectDir, '.instar'), projectName: 'proof', instarRoot: path.join(home, '.instar'),
      framework: () => 'claude-code', memoryPrivacy: () => ({ enabled: true }), messaging: () => messaging,
      sessionManager: manager, probe: async () => sandbox, slackBotUserId: () => 'B',
    });
    await wiring.ready;
    return wiring;
  }

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-privacy-spawn-')));
    projectDir = path.join(home, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar', 'state'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), '{}');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'rules');
    origHome = process.env.HOME;
    process.env.HOME = home;
    sessions.clear();
    vi.mocked(execFileSync).mockClear();
    messaging = [{ type: 'slack', config: { authorizedUserIds: ['U1', 'U2'] } }];
    sandbox = true;
    const config = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir, projectName: 'proof',
      port: 4999, authToken: 'agent-token', maxSessions: 5, protectedSessions: [], completionPatterns: [],
      framework: 'claude-code',
    } as unknown as SessionManagerConfig;
    manager = new SessionManager(config, new StateManager(path.join(projectDir, '.instar')));
    vi.spyOn(manager as unknown as { handleReadyAndInject(): Promise<void> }, 'handleReadyAndInject').mockResolvedValue(undefined);
    const pending = (manager as unknown as { pendingInjects: { record(e: unknown): void } }).pendingInjects;
    vi.spyOn(pending, 'record').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.HOME = origHome;
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/memory-privacy-spawn.test.ts' });
  });

  it('starts a channel session inside the boundary with no agent token', async () => {
    await wire();
    await manager.spawnInteractiveSession(undefined, 'chan', { slackChannelId: 'C1' });
    const args = lastLaunch();
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('dontAsk');
    expect(args).toContain('--settings');
    expect(envOf(args, 'INSTAR_AUTH_TOKEN')).toMatch(/^mps_/);
    expect(args.join(' ')).not.toContain('agent-token');
    expect(envOf(args, 'INSTAR_MEMORY_SCOPE')).toMatch(/^place-/);
    const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
    expect(settings.autoMemoryDirectory.startsWith(path.join(home, '.instar', 'memory-scopes', 'proof'))).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
  });

  it('on Linux, points the session curl at the sandbox proxy so replies reach the server', async () => {
    await wire();
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      await manager.spawnInteractiveSession(undefined, 'chan-curl', { slackChannelId: 'C9' });
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
    const args = lastLaunch();
    const curlHome = envOf(args, 'CURL_HOME');
    const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
    expect(curlHome).toBe(path.join(settings.autoMemoryDirectory, '.curl'));
    expect(fs.readFileSync(path.join(curlHome!, '.curlrc'), 'utf8')).toBe('noproxy = ""\n');
  });

  it('on macOS, leaves curl alone: the session shares the host loopback', async () => {
    await wire();
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await manager.spawnInteractiveSession(undefined, 'chan-curl-mac', { slackChannelId: 'C8' });
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
    expect(envOf(lastLaunch(), 'CURL_HOME')).toBeUndefined();
  });

  it('gives two people two folders', async () => {
    const { privacy } = await wire();
    privacy.recordPlace('slack:D1', 'private', 'pat');
    privacy.recordPlace('slack:D2', 'private', 'sam');
    await manager.spawnInteractiveSession(undefined, 'one', { slackChannelId: 'D1' });
    const first = lastLaunch();
    await manager.spawnInteractiveSession(undefined, 'two', { slackChannelId: 'D2' });
    const second = lastLaunch();
    expect(envOf(first, 'INSTAR_MEMORY_SCOPE')).not.toBe(envOf(second, 'INSTAR_MEMORY_SCOPE'));
    expect(envOf(first, 'INSTAR_MEMORY_SCOPE')).toMatch(/^person-/);
  });

  it('fails closed for a caller that names no place', async () => {
    await wire();
    await manager.spawnInteractiveSession(undefined, 'lost');
    expect(envOf(lastLaunch(), 'INSTAR_MEMORY_SCOPE')).toBe('none');
  });

  it('keeps owner reach for a console session', async () => {
    await wire();
    await manager.spawnInteractiveSession(undefined, 'console', { memoryPlace: { kind: 'system' } });
    const args = lastLaunch();
    expect(envOf(args, 'INSTAR_AUTH_TOKEN')).toBe('agent-token');
    expect(envOf(args, 'INSTAR_MEMORY_SCOPE')).toBe('system');
    expect(args).not.toContain('--settings');
  });

  it('refuses rather than launch unprotected when the sandbox does not start', async () => {
    sandbox = false;
    await wire();
    await expect(manager.spawnInteractiveSession(undefined, 'chan', { slackChannelId: 'C1' })).rejects.toBeInstanceOf(MemoryPrivacyUnavailableError);
    expect(lastLaunch()).toEqual([]);
  });

  it('drops a resume when the audience changed', async () => {
    const { privacy } = await wire();
    privacy.recordPlace('slack:D2', 'private', 'sam');
    privacy.audienceChanged('slack:D2', { kind: 'open' });
    await manager.spawnInteractiveSession(undefined, 'two', { slackChannelId: 'D2', resumeSessionId: '11111111-1111-4111-8111-111111111111' });
    expect(lastLaunch().join(' ')).not.toContain('11111111-1111');
  });

  it('copies an inbound file into the session inbox', async () => {
    await wire();
    await manager.spawnInteractiveSession(undefined, 'chan', { slackChannelId: 'C1' });
    const dir = path.join(projectDir, '.instar', 'telegram-inbound');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'long.txt'), 'made-up text');
    const session = manager.listRunningSessions().find((s) => s.name === 'chan')!;
    manager.injectMessage(session.tmuxSession, `[Long message saved to ${path.join(dir, 'long.txt')}]`, { firstParty: { source: 'test' } });
    expect(fs.readFileSync(path.join(session.memoryScopeDir!, 'inbox', 'long.txt'), 'utf8')).toBe('made-up text');
  });

  it('ends a session the keep-guards would protect, because it would answer next', async () => {
    messaging = [{ type: 'slack', config: { authorizedUserIds: ['U1'] } }];
    await wire();
    const tmux = await manager.spawnInteractiveSession(undefined, 'busy', { slackChannelId: 'D1' });
    manager.setReapGuard({ blockedReason: () => 'recent-user-message' } as never);
    expect(await manager.retireSessionUnlessAudience(tmux, 'person:sam')).toBe(true);
    expect(manager.listRunningSessions().some((s) => s.tmuxSession === tmux)).toBe(false);
  });

  it('will not reuse a same-name session for a different audience', async () => {
    const { privacy } = await wire();
    privacy.recordPlace('slack:D1', 'private', 'pat');
    privacy.recordPlace('slack:D2', 'private', 'sam');
    await manager.spawnInteractiveSession(undefined, 'shared-name', { slackChannelId: 'D1' });
    await manager.spawnInteractiveSession(undefined, 'shared-name', { slackChannelId: 'D2' });
    const scope = (s?: { memoryAudience?: string }) => s?.memoryAudience;
    expect(scope(manager.listRunningSessions().find((s) => s.name === 'shared-name'))).toBe('person:sam');
  });

  describe('single-person agent', () => {
    beforeEach(() => { messaging = [{ type: 'slack', config: { authorizedUserIds: ['U1'] } }]; });
    const launch = async (wired: boolean) => {
      if (wired) { const { privacy } = await wire(); privacy.recordPlace('slack:D1', 'private', 'pat'); }
      await manager.spawnInteractiveSession(undefined, 'dm', { slackChannelId: 'D1' });
      return lastLaunch().filter((a) => !/^(INSTAR_SESSION_ID|INSTAR_ORIGIN_TOKEN|INSTAR_BIND_TOKEN)=/.test(a));
    };
    it('launches exactly as with the feature absent', async () => {
      const without = await launch(false);
      sessions.clear();
      vi.mocked(execFileSync).mockClear();
      const withIt = await launch(true);
      expect(withIt).toEqual(without);
    });
  });
});
