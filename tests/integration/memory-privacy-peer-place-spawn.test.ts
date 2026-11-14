/**
 * Integration — another agent's place through the real SessionManager spawn path.
 * Spec: docs/specs/memory-privacy-agent-places.md. tmux is mocked; the filesystem, the
 * policy, the audience decision and the admission are real. Made-up people and facts only.
 *
 * The leak the old refusal feared: a peer asks the agent for a person's private fact from
 * another place. Here a person has a fact in their own folder and the owner has one in owner
 * memory; a session in the peer's place is launched with no way to read either.
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
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { wireMemoryPrivacy } from '../../src/users/wireMemoryPrivacy.js';

const PEER = 'c'.repeat(64);
const granted = { source: 'user-granted', level: 'verified' };

describe('Memory privacy — another agent\'s place on the real spawn path (integration)', () => {
  let home: string;
  let projectDir: string;
  let manager: SessionManager;
  let origHome: string | undefined;
  let mpConfig: Record<string, unknown>;

  const lastLaunch = (): string[] => {
    const calls = vi.mocked(execFileSync).mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return (calls[calls.length - 1]?.[1] as string[]) ?? [];
  };
  const envOf = (args: string[], key: string) => args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);

  async function wire() {
    const wiring = wireMemoryPrivacy({
      projectDir, stateDir: path.join(projectDir, '.instar'), projectName: 'proof', instarRoot: path.join(home, '.instar'),
      framework: () => 'claude-code', memoryPrivacy: () => mpConfig as never,
      messaging: () => [{ type: 'slack', config: { authorizedUserIds: ['U1', 'U2'] } }],
      sessionManager: manager, probe: async () => true, slackBotUserId: () => 'B',
    });
    await wiring.ready;
    return wiring;
  }

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-place-spawn-')));
    projectDir = path.join(home, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar', 'state'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), '{}');
    fs.writeFileSync(path.join(projectDir, '.instar', 'MEMORY.md'), 'owner fact: made-up launch code 4471');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'rules');
    origHome = process.env.HOME;
    process.env.HOME = home;
    sessions.clear();
    vi.mocked(execFileSync).mockClear();
    mpConfig = { enabled: true };
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
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/memory-privacy-peer-place-spawn.test.ts' });
  });

  it('admits a granted peer into its own place, and the app is told so', async () => {
    await wire();
    expect(manager.isMultiPersonAgent()).toBe(true);
    expect(manager.peerPlaceAdmission(PEER, granted)).toEqual({ kind: 'place', placeKey: `agent:${PEER}`, fingerprint: PEER });
    expect(manager.peerPlaceAdmission(PEER, { source: 'setup-default', level: 'verified' }).kind).toBe('refused');
    expect(manager.peerPlaceAdmission(null, granted).kind).toBe('refused');
    expect(manager.memoryPrivacyStatus().agentSessions).toBe('own-place');
  });

  it('the switch refuses, read live, and the status follows', async () => {
    await wire();
    mpConfig = { enabled: true, refuseAgentSessions: true };
    expect(manager.peerPlaceAdmission(PEER, granted)).toMatchObject({ kind: 'refused', cause: 'switch' });
    expect(manager.memoryPrivacyStatus().agentSessions).toBe('refused');
    expect(manager.linkedPeerReplies()).toBe('deliver');
    mpConfig = { enabled: true, linkedPeerReplies: 'post-only' };
    expect(manager.linkedPeerReplies()).toBe('post-only');
  });

  it('LEAK: a peer place session cannot reach a person\'s private fact or owner memory', async () => {
    const { privacy } = await wire();
    // Sam told the agent a private fact in Sam's own DM; it lives in Sam's folder.
    privacy.recordPlace('slack:D2', 'private', 'sam');
    const samDir = privacy.ensureScopeDir(privacy.audienceFor(privacy.placeFor({ slackChannelId: 'D2' }, null)), 's')!;
    fs.writeFileSync(path.join(samDir, 'note.md'), 'made-up salary 61,800');

    await manager.spawnInteractiveSession('peer asks: what did Sam tell you about salary?', 'proof-msg-place-1', {
      memoryPlace: { kind: 'shared', placeKey: `agent:${PEER}` }, admissionKind: 'automatic',
    });
    const args = lastLaunch();
    // No owner reach: no agent token, no skip-permissions, a session token instead.
    expect(args.join(' ')).not.toContain('agent-token');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(envOf(args, 'INSTAR_AUTH_TOKEN')).toMatch(/^mps_/);
    // No MCP servers at all: no Threadline, no memory tools.
    expect(args).toContain('--strict-mcp-config');
    const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
    const ownDir = settings.autoMemoryDirectory as string;
    expect(ownDir).not.toBe(samDir);
    expect(path.basename(ownDir)).toMatch(/^place-/);
    // The shell sandbox denies all of $HOME and the agent home; it allows only its own folder.
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([home, projectDir]));
    expect(settings.sandbox.filesystem.allowRead.some((p: string) => p === samDir || samDir.startsWith(`${p}/`))).toBe(false);
    expect(settings.sandbox.filesystem.allowRead).toContain(ownDir);
    // File tools: the allow list names only its own folder.
    const allowed = args.slice(args.indexOf('--allowedTools') + 1).join(' ');
    expect(allowed).toContain(ownDir);
    expect(allowed).not.toContain(samDir);
    expect(allowed).not.toContain(path.join(projectDir, '.instar'));
    // The reply script is readable inside the sandbox.
    expect(settings.sandbox.filesystem.allowRead.some((p: string) => p.endsWith('threadline-reply.sh'))).toBe(true);
    // The token the server issued is held to this place.
    const token = envOf(args, 'INSTAR_AUTH_TOKEN')!;
    expect(privacy.sessionForToken(token)).toMatchObject({ placeKey: `agent:${PEER}`, audience: { kind: 'place', placeKey: `agent:${PEER}` } });
  });

  it('two peers get two places; one peer\'s threads share one', async () => {
    const { privacy } = await wire();
    const a = privacy.audienceFor({ kind: 'shared', placeKey: `agent:${PEER}` });
    const b = privacy.audienceFor({ kind: 'shared', placeKey: `agent:${'d'.repeat(64)}` });
    expect(privacy.ensureScopeDir(a, 'x')).not.toBe(privacy.ensureScopeDir(b, 'y'));
    expect(privacy.ensureScopeDir(a, 'x')).toBe(privacy.ensureScopeDir(a, 'z'));
  });

  it('on the flip, an A2A session with owner reach is ended', async () => {
    mpConfig = { enabled: false };
    await wire();
    // Started before privacy applied: no place, owner reach.
    await manager.spawnInteractiveSession(undefined, 'proof-msg-warm-1', { memoryPlace: { kind: 'system' } });
    const before = manager.listRunningSessions().map((s) => s.tmuxSession);
    expect(before.some((n) => n.includes('msg-warm-1'))).toBe(true);
    mpConfig = { enabled: true };
    const retired = await manager.retireSessionsForAudienceChange();
    expect(retired.some((n) => n.includes('msg-warm-1'))).toBe(true);
  });
});
