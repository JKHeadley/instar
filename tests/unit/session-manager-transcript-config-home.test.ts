/**
 * SessionManager transcript probes honor a claude-code session's LIVE
 * CLAUDE_CONFIG_DIR (read from its tmux env), so a subscription-pool-routed
 * session's transcript is found under `<configHome>/projects` instead of the
 * default `~/.claude/projects` — where it never exists for such a session.
 *
 * Both sides of the boundary: a pooled claude session with a fresh transcript
 * under its config home reads ACTIVE; the same session with no config home in
 * its env falls back to the default home and honestly reads inactive; a codex
 * session never consults CLAUDE_CONFIG_DIR at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmuxEnv = vi.hoisted(() => ({
  configHomeBySession: new Map<string, string>(),
  showEnvironmentCalls: [] as string[],
}));

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'show-environment') {
      const target = args[2]?.replace(/^=/, '') ?? '';
      tmuxEnv.showEnvironmentCalls.push(target);
      const home = tmuxEnv.configHomeBySession.get(target);
      // tmux prints `-VAR` when the variable is unset in that session's env.
      return home ? `CLAUDE_CONFIG_DIR=${home}\n` : '-CLAUDE_CONFIG_DIR\n';
    }
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        if (cb) cb(null, { stdout: String(handle(args)) });
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, SessionManagerConfig } from '../../src/core/types.js';

describe('SessionManager transcript probes — live CLAUDE_CONFIG_DIR', () => {
  let tmpDir: string;
  let manager: SessionManager;
  let configHome: string;

  const session = (over: Partial<Session>): Session => ({
    id: 'sess', name: 'observer', status: 'running', tmuxSession: 'echo-observer', startedAt: new Date().toISOString(),
    claudeSessionId: 'sid-a', framework: 'claude-code', cwd: tmpDir, ...over,
  } as Session);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-transcript-home-'));
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude', projectDir: tmpDir,
      maxSessions: 5, protectedSessions: [], completionPatterns: ['Session complete'],
    };
    manager = new SessionManager(config, new StateManager(stateDir));
    configHome = path.join(tmpDir, 'claude-followme-pool-a');
    const transcriptDir = path.join(configHome, 'projects', tmpDir.replace(/[\/.]/g, '-'));
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, 'sid-a.jsonl'), '{"type":"session-event"}\n');
    tmuxEnv.configHomeBySession.clear();
    tmuxEnv.showEnvironmentCalls.length = 0;
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-transcript-config-home.test.ts' });
  });

  it('finds a pooled claude session\'s fresh transcript under its live config home', () => {
    tmuxEnv.configHomeBySession.set('echo-observer', configHome);
    expect(manager.isTranscriptRecentlyActive(session({}), 60_000)).toBe(true);
    expect(tmuxEnv.showEnvironmentCalls).toEqual(['echo-observer']);
  });

  it('with no CLAUDE_CONFIG_DIR in the session env it falls back to the default home and reads inactive', () => {
    // The transcript exists ONLY under the pool home; the default ~/.claude
    // path does not hold it, and the probe must not guess.
    expect(manager.isTranscriptRecentlyActive(session({}), 60_000)).toBe(false);
    expect(tmuxEnv.showEnvironmentCalls).toEqual(['echo-observer']);
  });

  it('a stale transcript under the config home still reads inactive (freshness is not bypassed)', () => {
    tmuxEnv.configHomeBySession.set('echo-observer', configHome);
    const file = path.join(configHome, 'projects', tmpDir.replace(/[\/.]/g, '-'), 'sid-a.jsonl');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, old, old);
    expect(manager.isTranscriptRecentlyActive(session({}), 60_000)).toBe(false);
  });

  it('a codex session never consults CLAUDE_CONFIG_DIR', () => {
    tmuxEnv.configHomeBySession.set('echo-observer', configHome);
    expect(manager.isTranscriptRecentlyActive(session({ framework: 'codex-cli' }), 60_000)).toBe(false);
    expect(tmuxEnv.showEnvironmentCalls).toEqual([]);
  });
});
