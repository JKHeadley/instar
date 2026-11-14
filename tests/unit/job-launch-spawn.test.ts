/**
 * T3 (frozen acceptance list, step3/acceptance-tests.md): the launch record is taken from what
 * was ACTUALLY spawned (spec job-launch-intent-record §3, "Verify the state"). Every `applied`
 * entry must appear in the final tmux new-session argv (as an exact flag/value pair) or its -e
 * env flags, on BOTH lanes:
 *   - headless (`claude -p`, codex exec), and
 *   - rerouted-interactive (subscriptionPathMode 'force' → spawnReroutedInteractive), harness from
 *     headless-spawn-reroute.test.ts.
 * Route fallback (D4): when the requested engine's headless lane is closed, the intent follows the
 * engine that actually launches; framework, model and binary on the session are the launched ones.
 * Red on main: spawnSession takes no thinkingMode and Session has no `launch`.
 *
 * Retained binary (T4 wiring): the version probe (SessionManager.probeLaunchVersion, the T5
 * contract) targets the binary that actually appears in the tmux argv — the retained copy that
 * resolveLaunchBinary returns — and a known retainer version is used without probing.
 *
 * Isolation: every case builds a fresh SessionManager in its own temp dir (and loop iterations do
 * too), so no case leans on session capacity left over from another.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
const newSessionArgvs: string[][] = [];
/** Headless lanes the test declares closed (route-fallback cases); empty = every lane open (main today). */
const closedLanes = vi.hoisted(() => new Set<string>());
/** `--version` answers by binary path, and every `--version` call made (any child_process API). */
const versions = vi.hoisted(() => ({ answers: new Map<string, string>(), calls: [] as string[] }));

vi.mock('node:child_process', () => {
  const version = (cmd: string): string => {
    versions.calls.push(cmd);
    const v = versions.answers.get(cmd);
    if (v === undefined) throw Object.assign(new Error(`no --version answer for ${cmd}`), { code: 'ENOENT' });
    return `${v} (Claude Code)\n`;
  };
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
    if (args[0] === 'display-message') return 'claude||claude';
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((cmd: string, args?: string[]) => (args?.[0] === '--version' ? version(cmd) : handle(args))),
    execFile: vi.fn().mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string; stderr?: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = args?.[0] === '--version' ? version(cmd) : handle(args); if (cb) cb(null, { stdout: String(out), stderr: '' }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

// Route fallback needs a closed headless lane; none is closed on main, so the test declares one
// through the resolver's own injected predicate (resolveHeadlessFallbackFramework's `isClosed`).
vi.mock('../../src/core/frameworkSessionLaunch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/frameworkSessionLaunch.js')>();
  return {
    ...real,
    headlessLaneIsClosed: (f: string) => closedLanes.has(f),
    resolveHeadlessFallbackFramework: (input: Parameters<typeof real.resolveHeadlessFallbackFramework>[0]) =>
      real.resolveHeadlessFallbackFramework({ ...input, isClosed: (f) => closedLanes.has(f) }),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

type Applied = { feature: string; requestedValue: string; value: string; channel: 'argv' | 'env' };
type LaunchedSession = {
  framework?: string; model?: string; launchLane?: string;
  launch?: { cliVersion: string; requested: { thinkingMode?: string }; applied: Applied[]; dropped: Array<Record<string, unknown>> };
};

const MODES = ['off', 'low', 'medium', 'high', 'max'] as const;
const CODEX_VALUE: Record<string, string> = { off: 'low', low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };

let roots: string[] = [];
function makeManager(opts: { mode?: 'off' | 'force'; extra?: Partial<SessionManagerConfig> } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-launch-spawn-'));
  roots.push(tmpDir);
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const claude = path.join(tmpDir, 'bin', 'claude');
  const codex = path.join(tmpDir, 'bin', 'codex');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  for (const b of [claude, codex]) { fs.writeFileSync(b, '#!/bin/sh\n'); fs.chmodSync(b, 0o755); }
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: claude,
    frameworkBinaryPaths: { 'claude-code': claude, 'codex-cli': codex, 'gemini-cli': path.join(tmpDir, 'bin', 'gemini') },
    projectName: 'proj',
    projectDir: tmpDir,
    maxSessions: 3,
    protectedSessions: [],
    completionPatterns: ['has been automatically paused'],
    framework: 'claude-code',
    ...(opts.mode ? { subscriptionPathMode: opts.mode } : {}),
    ...opts.extra,
  } as SessionManagerConfig;
  const manager = new SessionManager(config, new StateManager(stateDir));
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> }).waitForClaudeReadyWithRetry = async () => true;
  (manager as unknown as { currentMemoryPressure: () => string }).currentMemoryPressure = () => 'normal';
  return { manager, claude, codex };
}

function lastNewSession(): string[] {
  expect(newSessionArgvs.length, 'no tmux new-session was issued').toBeGreaterThan(0);
  return newSessionArgvs[newSessionArgvs.length - 1];
}
/** The launch argv: everything from the launched binary on. */
function launchArgv(args: string[], binary: string): string[] {
  const i = args.indexOf(binary);
  expect(i, `launched binary ${binary} not in the tmux argv`).toBeGreaterThan(-1);
  return args.slice(i);
}
/** The tmux -e env block, parsed. A key set twice keeps the last value (tmux semantics). */
function envFlags(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e') {
      const [k, ...v] = args[i + 1].split('=');
      env[k] = v.join('=');
    }
  }
  return env;
}

/**
 * Proves one `applied` entry against the spawned command, by exact pairing:
 *   claude argv  → exactly one `--effort`, immediately followed by the value;
 *   codex argv   → exactly one `-c` immediately followed by `model_reasoning_effort="<value>"`;
 *   env          → value is `KEY=VAL` and the tmux -e block sets exactly that.
 */
function assertAppliedSpawned(a: Applied, framework: string, args: string[], binary: string) {
  const argv = launchArgv(args, binary);
  if (a.channel === 'env') {
    const [k, v] = a.value.split('=');
    expect(envFlags(args)[k], `env ${a.value} not in the spawned -e flags`).toBe(v);
    return;
  }
  if (framework === 'claude-code') {
    const at = argv.flatMap((x, i) => (x === '--effort' ? [i] : []));
    expect(at, `expected exactly one --effort in ${JSON.stringify(argv)}`).toHaveLength(1);
    expect(argv[at[0] + 1]).toBe(a.value);
  } else if (framework === 'codex-cli') {
    const at = argv.flatMap((x, i) => (x === '-c' && argv[i + 1] === `model_reasoning_effort=${JSON.stringify(a.value)}` ? [i] : []));
    expect(at, `expected exactly one -c model_reasoning_effort="${a.value}" pair in ${JSON.stringify(argv)}`).toHaveLength(1);
    expect(argv.filter((x) => x.includes('model_reasoning_effort'))).toHaveLength(1);
  } else {
    expect.fail(`no argv channel is expected for ${framework}`);
  }
}

function expectedApplied(framework: 'claude-code' | 'codex-cli', mode: string): Applied[] {
  if (framework === 'codex-cli') return [{ feature: 'thinkingMode', requestedValue: mode, value: CODEX_VALUE[mode], channel: 'argv' }];
  return mode === 'off'
    ? [{ feature: 'thinkingMode', requestedValue: 'off', value: 'MAX_THINKING_TOKENS=0', channel: 'env' }]
    : [{ feature: 'thinkingMode', requestedValue: mode, value: mode, channel: 'argv' }];
}

async function spawn(manager: SessionManager, opts: Record<string, unknown>): Promise<LaunchedSession> {
  return (await manager.spawnSession({ prompt: 'p', ...opts } as never)) as unknown as LaunchedSession;
}

describe('T3 launch record comes from the spawned argv/env', () => {
  beforeEach(() => {
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
    closedLanes.clear();
    versions.answers.clear();
    versions.calls.length = 0;
    roots = [];
  });
  afterEach(() => {
    for (const r of roots) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'tests/unit/job-launch-spawn.test.ts:cleanup' });
  });

  describe('headless lane', () => {
    for (const mode of MODES) {
      it(`claude-code ${mode}: non-empty expected record, each entry in the spawned command`, async () => {
        const { manager, claude } = makeManager();
        try {
          const s = await spawn(manager, { name: `job-claude-${mode}`, thinkingMode: mode });
          const args = lastNewSession();
          expect(s.launchLane).toBe('headless');
          expect(s.launch, 'Session.launch is missing').toBeDefined();
          expect(s.launch!.requested).toEqual({ thinkingMode: mode });
          expect(s.launch!.applied).toEqual(expectedApplied('claude-code', mode));
          expect(s.launch!.dropped).toEqual([]);
          for (const a of s.launch!.applied) assertAppliedSpawned(a, 'claude-code', args, claude);
          if (mode === 'off') expect(launchArgv(args, claude)).not.toContain('--effort');
        } finally { manager.stopMonitoring(); }
      });
    }

    for (const mode of MODES) {
      it(`codex-cli ${mode}: the -c pair is in the spawned argv`, async () => {
        const { manager, codex } = makeManager({ extra: { framework: 'codex-cli', enabledFrameworks: ['codex-cli'] } as never });
        try {
          const s = await spawn(manager, { name: `job-codex-${mode}`, framework: 'codex-cli', thinkingMode: mode });
          const args = lastNewSession();
          expect(s.framework).toBe('codex-cli');
          expect(s.launch, 'Session.launch is missing').toBeDefined();
          expect(s.launch!.applied).toEqual(expectedApplied('codex-cli', mode));
          for (const a of s.launch!.applied) assertAppliedSpawned(a, 'codex-cli', args, codex);
        } finally { manager.stopMonitoring(); }
      });
    }

    it('field absent: launch present with empty applied/dropped, and no effort flag or env', async () => {
      const { manager, claude } = makeManager();
      try {
        const s = await spawn(manager, { name: 'job-none' });
        const args = lastNewSession();
        expect(s.launch).toEqual(expect.objectContaining({ requested: {}, applied: [], dropped: [] }));
        expect(launchArgv(args, claude)).not.toContain('--effort');
        expect(envFlags(args).MAX_THINKING_TOKENS).toBeUndefined();
      } finally { manager.stopMonitoring(); }
    });
  });

  describe('rerouted-interactive lane (subscriptionPathMode force)', () => {
    for (const mode of MODES) {
      it(`claude-code ${mode}: rerouted spawn carries the intent and records it`, async () => {
        const { manager, claude } = makeManager({ mode: 'force' });
        try {
          const s = await spawn(manager, { name: `job-reroute-${mode}`, thinkingMode: mode, jobSlug: `reroute-${mode}`, triggeredBy: 'scheduler:test' });
          const args = lastNewSession();
          expect(s.launchLane, 'the reroute did not happen — this case would not test the rerouted lane').not.toBe('headless');
          expect(launchArgv(args, claude)).not.toContain('-p');
          expect(s.launch, 'rerouted Session.launch is missing').toBeDefined();
          expect(s.launch!.requested).toEqual({ thinkingMode: mode });
          expect(s.launch!.applied).toEqual(expectedApplied('claude-code', mode));
          expect(s.launch!.dropped).toEqual([]);
          for (const a of s.launch!.applied) assertAppliedSpawned(a, 'claude-code', args, claude);
        } finally { manager.stopMonitoring(); }
      });
    }

    it('field absent on the rerouted lane: empty arrays, no effort flag or env', async () => {
      const { manager, claude } = makeManager({ mode: 'force' });
      try {
        const s = await spawn(manager, { name: 'job-reroute-none', jobSlug: 'reroute-none', triggeredBy: 'scheduler:test' });
        const args = lastNewSession();
        expect(s.launchLane).not.toBe('headless');
        expect(s.launch).toEqual(expect.objectContaining({ requested: {}, applied: [], dropped: [] }));
        expect(launchArgv(args, claude)).not.toContain('--effort');
        expect(envFlags(args).MAX_THINKING_TOKENS).toBeUndefined();
      } finally { manager.stopMonitoring(); }
    });
  });

  describe('invalid thinkingMode through a real SessionManager: clamped, never recorded raw', () => {
    const RAW = 'ultra-hostile-input';
    const BAD: Array<[string, unknown]> = [['invalid string', RAW], ['non-string', { evil: RAW }], ['number', 7]];
    for (const [lane, mode] of [['headless', undefined], ['rerouted', 'force']] as const) {
      for (const [label, bad] of BAD) {
        it(`${lane}: ${label}`, async () => {
          const { manager, claude } = makeManager(mode ? { mode } : {});
          try {
            const s = await spawn(manager, {
              name: `job-invalid-${lane}-${label.replace(/\W+/g, '-')}`, thinkingMode: bad,
              ...(mode ? { jobSlug: 'invalid-reroute', triggeredBy: 'scheduler:test' } : {}),
            });
            const args = lastNewSession();
            if (mode) expect(s.launchLane, 'the reroute did not happen').not.toBe('headless');
            else expect(s.launchLane).toBe('headless');
            expect(s.launch, 'Session.launch is missing').toBeDefined();
            expect(s.launch!.requested).toEqual({});
            expect(s.launch!.applied).toEqual([]);
            expect(s.launch!.dropped).toEqual([{ feature: 'thinkingMode', reason: 'invalid' }]);
            expect(s.launch!.dropped[0]).not.toHaveProperty('requestedValue');
            expect(launchArgv(args, claude)).not.toContain('--effort');
            expect(envFlags(args).MAX_THINKING_TOKENS).toBeUndefined();
            const recorded = JSON.stringify(s.launch);
            for (const needle of ['ultra', 'hostile', 'evil', ':7']) expect(recorded, `raw input reached the record: ${recorded}`).not.toContain(needle);
            expect(args.join(' ')).not.toContain('hostile');
          } finally { manager.stopMonitoring(); }
        });
      }
    }
  });

  describe('route fallback (D4): the intent follows the engine that launches', () => {
    for (const mode of ['off', 'max'] as const) {
      it(`gemini-cli requested with its headless lane closed → codex-cli launches; ${mode} is applied as codex`, async () => {
        closedLanes.add('gemini-cli');
        const { manager, codex } = makeManager({
          extra: {
            framework: 'gemini-cli', enabledFrameworks: ['codex-cli', 'gemini-cli'],
            frameworkDefaultModels: { 'codex-cli': 'gpt-6-sol', 'gemini-cli': 'gemini-2.5-pro' },
          } as never,
        });
        try {
          const s = await spawn(manager, { name: `job-fallback-${mode}`, framework: 'gemini-cli', thinkingMode: mode });
          const args = lastNewSession();
          const argv = launchArgv(args, codex);
          // framework / binary / model are the LAUNCHED ones.
          expect(s.framework).toBe('codex-cli');
          expect(argv[0]).toBe(codex);
          expect(argv[1]).toBe('exec');
          const m = argv.lastIndexOf('-m');
          expect(s.model).toBe(argv[m + 1]);
          expect(s.model).toBe('gpt-6-sol');
          // The intent follows the launched engine (not gemini's not-supported).
          expect(s.launch, 'Session.launch is missing on the fallback spawn').toBeDefined();
          expect(s.launch!.requested).toEqual({ thinkingMode: mode });
          expect(s.launch!.applied).toEqual(expectedApplied('codex-cli', mode));
          expect(s.launch!.dropped).toEqual([]);
          for (const a of s.launch!.applied) assertAppliedSpawned(a, 'codex-cli', args, codex);
        } finally { manager.stopMonitoring(); }
      });
    }

    it('the fallback is real in this harness (control: without the closed lane, gemini launches and drops)', async () => {
      const { manager } = makeManager({ extra: { framework: 'gemini-cli', enabledFrameworks: ['codex-cli', 'gemini-cli'] } as never });
      try {
        const s = await spawn(manager, { name: 'job-nofallback', framework: 'gemini-cli', thinkingMode: 'low' });
        expect(s.framework).toBe('gemini-cli');
        expect(s.launch, 'Session.launch is missing').toBeDefined();
        expect(s.launch!.applied).toEqual([]);
        expect(s.launch!.dropped).toEqual([{ feature: 'thinkingMode', requestedValue: 'low', reason: 'not-supported' }]);
      } finally { manager.stopMonitoring(); }
    });
  });

  describe('the probed binary is the one that launched (retained copy, CMT-798)', () => {
    /** Point the real resolveLaunchBinary at a distinct retained copy (the retainer's own disk copy is
     *  stubbed, nothing else): configured and retained binaries answer different versions. */
    function withRetained(manager: SessionManager, tmp: string, version: string | null) {
      const retained = path.join(tmp, 'retained', '2.1.322', 'claude');
      fs.mkdirSync(path.dirname(retained), { recursive: true });
      fs.writeFileSync(retained, '#!/bin/sh\n');
      fs.chmodSync(retained, 0o755);
      const retainer = (manager as unknown as { claudeBinaryRetainer: Record<string, unknown> }).claudeBinaryRetainer;
      retainer.resolve = (configured: string) => ({ path: retained, source: 'retained', version, key: 'k', sourcePath: configured });
      retainer.prune = async () => undefined;
      return retained;
    }
    type Probing = { probeLaunchVersion?: (s: unknown) => Promise<string> };

    it('retainer version null: the probe runs on the retained binary in the tmux argv, never the configured one', async () => {
      const { manager, claude } = makeManager();
      try {
        const retained = withRetained(manager, path.dirname(path.dirname(claude)), null);
        versions.answers.set(claude, '9.9.9');
        versions.answers.set(retained, '2.1.322');
        const s = await spawn(manager, { name: 'job-retained', thinkingMode: 'low' });
        const args = lastNewSession();
        expect(launchArgv(args, retained)[0], 'the spawn did not launch the retained copy').toBe(retained);
        expect(args, 'the configured binary leaked into the launch').not.toContain(claude);
        expect(s.launch, 'Session.launch is missing').toBeDefined();
        // At spawn the record may already hold the retained binary's version (a warm cache) or
        // 'unknown' (patched later) — but never the CONFIGURED binary's 9.9.9.
        expect(['unknown', '2.1.322'], `spawn-time cliVersion ${s.launch!.cliVersion}`).toContain(s.launch!.cliVersion);
        expect(typeof (manager as unknown as Probing).probeLaunchVersion, 'SessionManager.probeLaunchVersion is missing').toBe('function');
        const v = await (manager as unknown as Required<Probing>).probeLaunchVersion(s);
        expect(v).toBe('2.1.322');
        expect(versions.calls.length, 'no --version probe was made').toBeGreaterThan(0);
        expect(new Set(versions.calls), 'probed a binary other than the one in the tmux argv').toEqual(new Set([retained]));
      } finally { manager.stopMonitoring(); }
    });

    it('retainer version known: the record carries it at spawn, and the probe does not re-run --version', async () => {
      const { manager, claude } = makeManager();
      try {
        const retained = withRetained(manager, path.dirname(path.dirname(claude)), '2.1.300');
        versions.answers.set(claude, '9.9.9');
        versions.answers.set(retained, '2.1.322');
        const s = await spawn(manager, { name: 'job-retained-known', thinkingMode: 'low' });
        expect(launchArgv(lastNewSession(), retained)[0]).toBe(retained);
        expect(s.launch, 'Session.launch is missing').toBeDefined();
        expect(s.launch!.cliVersion).toBe('2.1.300');
        expect(typeof (manager as unknown as Probing).probeLaunchVersion, 'SessionManager.probeLaunchVersion is missing').toBe('function');
        expect(await (manager as unknown as Required<Probing>).probeLaunchVersion(s)).toBe('2.1.300');
        expect(versions.calls).toEqual([]);
      } finally { manager.stopMonitoring(); }
    });

    it('forced reroute lane: the retained copy launches and is the only binary probed', async () => {
      const { manager, claude } = makeManager({ mode: 'force' });
      try {
        const retained = withRetained(manager, path.dirname(path.dirname(claude)), null);
        versions.answers.set(claude, '9.9.9');
        versions.answers.set(retained, '2.1.322');
        const s = await spawn(manager, { name: 'job-retained-reroute', thinkingMode: 'low', jobSlug: 'retained-reroute', triggeredBy: 'scheduler:test' });
        const args = lastNewSession();
        expect(s.launchLane, 'the reroute did not happen').not.toBe('headless');
        expect(launchArgv(args, retained)[0]).toBe(retained);
        expect(args).not.toContain(claude);
        expect(s.launch, 'rerouted Session.launch is missing').toBeDefined();
        expect(['unknown', '2.1.322']).toContain(s.launch!.cliVersion);
        expect(typeof (manager as unknown as Probing).probeLaunchVersion, 'SessionManager.probeLaunchVersion is missing').toBe('function');
        expect(await (manager as unknown as Required<Probing>).probeLaunchVersion(s)).toBe('2.1.322');
        expect(new Set(versions.calls), 'probed a binary other than the one in the tmux argv').toEqual(new Set([retained]));
      } finally { manager.stopMonitoring(); }
    });
  });
});
