// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * EVO-008 consumer test (docs/specs/job-tool-allowlist-real-enforcement.md §3b, §4): a
 * scheduler-shaped spawn with `confinedTools` produces a final argv that meets the WHOLE
 * confinement contract on both Claude lanes, records `session.confinedTools` only then,
 * leads every confined prompt with a plain line, refuses a tamper-required spawn on a
 * non-Claude lane before launching, and keeps a control character out of later writes.
 * tmux is mocked at node:child_process, mirroring session-manager-triage-spawn.test.ts.
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

import { SessionManager, assertClaudeConfinementContract, CONFINED_PROMPT_LEAD } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const CLAUDE = '/usr/local/bin/claude';
const CODEX = '/usr/local/bin/codex';

function makeManager(tmpDir: string, mode: 'off' | 'force', extra: Partial<SessionManagerConfig> = {}) {
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const state = new StateManager(stateDir);
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux', claudePath: CLAUDE,
    frameworkBinaryPaths: { 'claude-code': CLAUDE, 'codex-cli': CODEX, 'gemini-cli': '/usr/local/bin/gemini' },
    enabledFrameworks: ['claude-code', 'codex-cli'],
    projectName: 'proj', projectDir: tmpDir, maxSessions: 10, protectedSessions: [], completionPatterns: [],
    authToken: 'instar-real-token',
    subscriptionPathMode: mode,
    ...extra,
  };
  const manager = new SessionManager(config, state, { bindMaintenanceTickForTesting: () => {} });
  (manager as unknown as { currentMemoryPressure: () => string }).currentMemoryPressure = () => 'normal';
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> }).waitForClaudeReadyWithRetry = async () => true;
  (manager as unknown as { injectAfterReady: () => Promise<void> }).injectAfterReady = async () => {};
  return { manager, state };
}

const valueAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe('EVO-008: scheduled-job tool confinement at the launch (consumer)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-job-confine-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
    sentKeys.length = 0;
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-job-confinement.test.ts' });
  });

  for (const mode of ['off', 'force'] as const) {
    const lane = mode === 'force' ? 'rerouted-interactive' : 'headless';
    it(`${lane}: a scheduled job with confinedTools launches in the whole confined form and records it`, async () => {
      const { manager } = makeManager(tmpDir, mode);
      const session = await manager.spawnSession({
        name: `job-doorway-${mode}`, prompt: '!touch /tmp/should-not-run', jobSlug: 'doorway-scan',
        triggeredBy: 'scheduler:cron', allowedTools: ['Bash'], confinedTools: ['Bash'],
      });
      const argv = newSessionArgvs.at(-1)!;
      const launch = argv.slice(argv.indexOf(CLAUDE));
      expect(session.launchLane).toBe(lane);
      expect(launch).not.toContain('--dangerously-skip-permissions');
      expect(valueAfter(launch, '--permission-mode')).toBe('dontAsk');
      expect(valueAfter(launch, '--tools')).toBe('Bash');
      expect(valueAfter(launch, '--allowedTools')).toBe('Bash');
      expect(launch).toContain('--no-chrome');
      expect(launch).toContain('--strict-mcp-config');
      expect(launch.filter((a) => a === '--mcp-config')).toHaveLength(1);
      expect(() => assertClaudeConfinementContract(launch, ['Bash'])).not.toThrow();
      // The consumer record the scheduler reads as proof.
      expect(session.confinedTools).toEqual(['Bash']);
      // §3b guard 1: the prompt never starts with the body's control character.
      expect(session.prompt?.startsWith(`${CONFINED_PROMPT_LEAD}\n!touch`)).toBe(true);
      if (mode === 'off') expect(launch.at(-1)!.startsWith(CONFINED_PROMPT_LEAD)).toBe(true);
    });
  }

  it('an unconfined job launch is unchanged: bypass flag present, no confinedTools, prompt untouched', async () => {
    const { manager } = makeManager(tmpDir, 'off');
    const session = await manager.spawnSession({ name: 'job-plain', prompt: 'do the thing', jobSlug: 'plain', allowedTools: ['Read'] });
    const launch = newSessionArgvs.at(-1)!;
    expect(launch).toContain('--dangerously-skip-permissions');
    expect(session.confinedTools).toBeUndefined();
    expect(session.prompt).toBe('do the thing');
  });

  it('a Codex launch ignores confinedTools and does NOT record a confinement', async () => {
    const { manager } = makeManager(tmpDir, 'off');
    const session = await manager.spawnSession({
      name: 'job-codex', prompt: 'p', jobSlug: 'array-job', framework: 'codex-cli', confinedTools: ['Read'],
    });
    expect(session.framework).toBe('codex-cli');
    expect(session.confinedTools).toBeUndefined();
  });

  it('requireToolConfinement refuses a non-Claude launch BEFORE starting anything (tamper fails closed)', async () => {
    const { manager } = makeManager(tmpDir, 'off');
    await expect(manager.spawnSession({
      name: 'job-tampered', prompt: 'p', jobSlug: 'tampered', framework: 'codex-cli',
      confinedTools: ['Read'], requireToolConfinement: true,
    })).rejects.toThrow(/confined-tools-unavailable/);
    expect(newSessionArgvs).toHaveLength(0);
  });

  it('requireToolConfinement on Claude launches confined', async () => {
    const { manager } = makeManager(tmpDir, 'off');
    const session = await manager.spawnSession({
      name: 'job-tampered-claude', prompt: 'p', jobSlug: 'tampered', framework: 'claude-code',
      confinedTools: ['Read'], requireToolConfinement: true,
    });
    expect(session.confinedTools).toEqual(['Read']);
  });

  it('the final-argv contract refuses every way the confined form can be undone', () => {
    const good = [CLAUDE, '--permission-mode', 'dontAsk', '--tools', 'Read', '--no-chrome', '--allowedTools', 'Read',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '-p', 'x'];
    expect(() => assertClaudeConfinementContract(good, ['Read'])).not.toThrow();
    const bad: Array<[string, string[]]> = [
      ['bypass flag', [...good.slice(0, 1), '--dangerously-skip-permissions', ...good.slice(1)]],
      ['extra mcp config', [...good.slice(0, -2), '--mcp-config', '/agent/threadline.json', ...good.slice(-2)]],
      ['non-empty mcp config', good.map((a) => (a === '{"mcpServers":{}}' ? '{"mcpServers":{"x":{}}}' : a))],
      ['wrong tools', good.map((a, i) => (good[i - 1] === '--tools' ? 'Read,Bash' : a))],
      ['no dontAsk', good.map((a) => (a === 'dontAsk' ? 'default' : a))],
      ['no --no-chrome', good.filter((a) => a !== '--no-chrome')],
      ['no strict', good.filter((a) => a !== '--strict-mcp-config')],
    ];
    for (const [label, argv] of bad) {
      expect(() => assertClaudeConfinementContract(argv, ['Read']), label).toThrow(/confined-tools-adapter-missing/);
    }
  });

  it('§3b: the outside writer (server tmuxOps.sendKeys) is refused for a confinedTools session only', async () => {
    const { manager } = makeManager(tmpDir, 'off');
    const confined = await manager.spawnSession({ name: 'job-c2', prompt: 'p', jobSlug: 'c2', confinedTools: ['Read'] });
    const plain = await manager.spawnSession({ name: 'job-u2', prompt: 'p', jobSlug: 'u2' });
    expect(manager.isConfinedWriteRefused(confined.tmuxSession)).toBe(true);
    expect(manager.isConfinedWriteRefused(plain.tmuxSession)).toBe(false);
  });

  it('a confined triage session is refused to the outside writer too', async () => {
    const { manager } = makeManager(tmpDir, 'off');
    const triage = await manager.spawnSession({
      name: 'triage-health-check-x', prompt: 'investigate', jobSlug: 'triage:health-check',
      omitAuthEnv: true, confinedTools: ['Read', 'Grep'],
    });
    expect(triage.confinedTools).toEqual(['Read', 'Grep']);
    expect(manager.isConfinedWriteRefused(triage.tmuxSession)).toBe(true);
  });

  it('§3b guard 2: a later write starting with !, / or # goes into a confined session behind the lead line only', async () => {
    const { manager } = makeManager(tmpDir, 'off');
    const confined = await manager.spawnSession({ name: 'job-c', prompt: 'p', jobSlug: 'c', confinedTools: ['Read'] });
    const plain = await manager.spawnSession({ name: 'job-u', prompt: 'p', jobSlug: 'u' });
    const guard = (tmux: string, text: string) =>
      (manager as unknown as { guardConfinedToolsText: (t: string, x: string) => string }).guardConfinedToolsText(tmux, text);
    for (const text of ['!touch /tmp/x', '/permissions', '#remember this', '  !spaced']) {
      expect(guard(confined.tmuxSession, text)).toBe(`${CONFINED_PROMPT_LEAD}\n${text}`);
      expect(guard(plain.tmuxSession, text)).toBe(text);
    }
    expect(guard(confined.tmuxSession, 'continue the task')).toBe('continue the task');
  });
});
