// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Triage-session spawn options (job-cost-reduction §5.6.2): `omitAuthEnv` on the rerouted
 * interactive lane (subscriptionPath.mode force) blanks the agent's authority and honours
 * maxDurationMinutes; `confinedTools` applies the positive confinement form on both lanes;
 * `useAgentDefaultModel` ignores the job tier. tmux is mocked at node:child_process, mirroring
 * session-manager-confined-reroute.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
const newSessionArgvs: string[][] = [];
/** Every send-keys call (literal payloads and named keys), in order. */
const sentKeys: string[] = [];
/** Scripted visible-screen frames for `capture-pane -p` without `-S` (the confined startup capture). */
let screenFrames: string[] = [];
let lastScreen = '';
/** What a scrollback capture (`capture-pane ... -S -N`, the monitor loop's read) returns. */
let tailFrame = '';

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'send-keys') {
      if (args.includes('-l')) {
        let at = args.indexOf('-l') + 1;
        if (args[at] === '--') at += 1;
        sentKeys.push(`literal:${args[at]}`);
        lastScreen = `${'─'.repeat(80)}\n❯ ${args[at]}\n${'─'.repeat(80)}\n  ⏵⏵ don't ask on (shift+tab to cycle)`;
      } else {
        sentKeys.push(`key:${args[args.length - 1]}`);
      }
      return '';
    }
    if (args[0] === 'capture-pane' && (tailFrame || args.includes('-S'))) return tailFrame;
    if (args[0] === 'capture-pane' && !args.includes('-S')) {
      if (screenFrames.length > 0) lastScreen = screenFrames.shift()!;
      return lastScreen;
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
  };
});

import { SessionManager, applyClaudeToolConfinement } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const CLAUDE = '/usr/local/bin/claude';

function makeManager(tmpDir: string, mode: 'off' | 'force', extra: Partial<SessionManagerConfig> = {}) {
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const state = new StateManager(stateDir);
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux', claudePath: CLAUDE,
    frameworkBinaryPaths: { 'claude-code': CLAUDE, 'codex-cli': '/usr/local/bin/codex', 'gemini-cli': '/usr/local/bin/gemini' },
    projectName: 'proj', projectDir: tmpDir, maxSessions: 10, protectedSessions: [], completionPatterns: [],
    authToken: 'instar-real-token',
    subscriptionPathMode: mode,
    ...extra,
  };
  const manager = new SessionManager(config, state, { bindMaintenanceTickForTesting: () => {} });
  (manager as unknown as { currentMemoryPressure: () => string }).currentMemoryPressure = () => 'normal';
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> }).waitForClaudeReadyWithRetry = async () => true;
  (manager as unknown as { injectAfterReady: () => Promise<void> }).injectAfterReady = async () => {};
  return manager;
}

const TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const envOf = (argv: string[]) => argv.filter((_a, i) => argv[i - 1] === '-e');

describe('triage spawn options', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-triage-spawn-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
    sentKeys.length = 0;
    process.env.GH_TOKEN = 'gh-real';
    process.env.TRIAGE_TEST_SECRET_TOKEN = 'blank-me';
  });
  afterEach(() => {
    delete process.env.GH_TOKEN;
    delete process.env.TRIAGE_TEST_SECRET_TOKEN;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-triage-spawn.test.ts' });
  });

  for (const mode of ['force', 'off'] as const) {
    const lane = mode === 'force' ? 'rerouted-interactive' : 'headless';
    it(`${lane}: omitAuthEnv carries no INSTAR_AUTH_TOKEN, INSTAR_ORIGIN_TOKEN or GitHub token; confined tools; no MCP`, async () => {
      const manager = makeManager(tmpDir, mode);
      const session = await manager.spawnSession({
        name: 'triage-health-check-1', prompt: 'investigate', jobSlug: 'triage:health-check', framework: 'claude-code',
        omitAuthEnv: true, confinedTools: TOOLS, maxDurationMinutes: 30, model: 'haiku', useAgentDefaultModel: true,
      });
      const argv = newSessionArgvs.at(-1)!;
      expect(session.launchLane).toBe(lane);
      const env = envOf(argv);
      expect(env).toContain('INSTAR_AUTH_TOKEN=');
      expect(argv.join(' ')).not.toContain('instar-real-token');
      expect(env).toContain('INSTAR_ORIGIN_TOKEN=');
      expect(env.filter((e) => e.startsWith('INSTAR_ORIGIN_TOKEN='))).toEqual(['INSTAR_ORIGIN_TOKEN=']);
      expect(argv.join(' ')).not.toContain('gh-real');
      expect(env).toEqual(expect.arrayContaining(['GH_TOKEN=', 'GITHUB_TOKEN=', 'INSTAR_BIND_TOKEN=', 'INSTAR_FENCING_TOKEN=', 'TRIAGE_TEST_SECRET_TOKEN=']));
      const launch = argv.slice(argv.indexOf(CLAUDE));
      expect(launch).not.toContain('--dangerously-skip-permissions');
      expect(launch).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob,Bash', '--no-chrome',
        '--allowedTools', 'Read,Grep,Glob,Bash', '--strict-mcp-config', '--mcp-config']));
      expect(launch.join(' ')).not.toMatch(/haiku/i);
      expect(session.maxDurationMinutes).toBe(30);
      if (mode === 'force') expect(session.maxLifetimeMinutes).toBe(30);
    });
  }

  it('rerouted lane without omitAuthEnv is unchanged (agent token, 45-minute lifetime)', async () => {
    const manager = makeManager(tmpDir, 'force');
    const session = await manager.spawnSession({ name: 'job-x', prompt: 'p', jobSlug: 'some-job', maxDurationMinutes: 10 });
    const argv = newSessionArgvs.at(-1)!;
    expect(argv).toContain('INSTAR_AUTH_TOKEN=instar-real-token');
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(session.maxLifetimeMinutes).toBe(45);
  });

  it('omitAuthEnv still refuses an env-token agent', async () => {
    const manager = makeManager(tmpDir, 'force', { anthropicApiKey: 'sk-ant-api-xyz' });
    await expect(manager.spawnSession({ name: 'triage-x', prompt: 'p', omitAuthEnv: true, confinedTools: TOOLS })).rejects.toThrow(/omit-auth-env-unsupported/);
  });

  it('confinedTools conflicts with confinement and must be non-empty', async () => {
    const manager = makeManager(tmpDir, 'off');
    await expect(manager.spawnSession({ name: 't1', prompt: 'p', omitAuthEnv: true, confinedTools: [] })).rejects.toThrow(/confined-tools-invalid/);
    await expect(manager.spawnSession({ name: 't2', prompt: 'p', omitAuthEnv: true, confinedTools: TOOLS,
      confinement: { framework: 'claude-code', settingsPath: '/x', tmpDir: '/tmp/x' } })).rejects.toThrow(/confined-tools-conflicts/);
  });

  it('applyClaudeToolConfinement asserts the mode was applied', () => {
    const argv = [CLAUDE, '--dangerously-skip-permissions', '--strict-mcp-config', '--mcp-config', '{}', '-p', 'x'];
    applyClaudeToolConfinement(argv, TOOLS);
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv.indexOf('--tools')).toBeLessThan(argv.indexOf('-p'));
    // no MCP-disable flag ⇒ the assert fails the spawn
    expect(() => applyClaudeToolConfinement([CLAUDE, '--dangerously-skip-permissions'], TOOLS)).toThrow(/confined-tools-adapter-missing/);
    expect(() => applyClaudeToolConfinement([CLAUDE, '--strict-mcp-config'], ['Bash;rm'])).toThrow(/confined-tools-invalid/);
  });
});
