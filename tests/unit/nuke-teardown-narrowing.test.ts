/**
 * Unit tests for docs/specs/nuke-teardown-narrowing.md.
 *
 * SANDBOX (required by the spec's Testing section): every external effect is
 * faked. `node:child_process` is mocked so tmux, launchctl, plutil and
 * systemctl hit an in-memory emulator (git still runs for real, in tmp dirs);
 * `./setup.js`, SecretManager, AgentRegistry and `standaloneAgentsDir` are
 * mocked; HOME is a fresh temp folder per test; every name starts with `zz-`.
 * No test reaches the real ~/.instar, ~/Library/LaunchAgents, launchctl or the
 * default tmux server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type FakeSession = { id: string; name: string; path: string };

const h = vi.hoisted(() => {
  const state = {
    home: '',
    sessions: [] as FakeSession[],
    nextId: 1,
    calls: [] as Array<{ cmd: string; args: string[] }>,
    /** Override for a tmux sub-command: return a value or throw. */
    tmuxOverride: null as null | ((args: string[]) => { handled: boolean; value?: string }),
    /** Hook run after a kill-session removes a session. */
    afterKill: null as null | ((killed: FakeSession) => void),
    /** Sessions that survive kill-session (the kill "succeeds" but the session stays). */
    unkillable: new Set<string>(),
    launchd: {
      loaded: false,
      printError: null as null | { status: number; stderr: string },
      listOutput: null as null | string,
      listError: null as null | { status: number; stderr: string },
      bootoutLeavesLoaded: false,
      plutilError: null as null | string,
    },
    systemd: {
      showOutput: '' as string,
      showError: null as null | string,
      stopError: null as null | string,
      disableError: null as null | string,
      isActive: 'inactive',
    },
    unregister: null as null | ((p: string) => void),
  };
  return state;
});

function tmuxErr(msg: string, status = 1): Error {
  const e = new Error(`Command failed: tmux\n${msg}`) as Error & { stderr: Buffer; status: number };
  e.stderr = Buffer.from(msg + '\n');
  e.status = status;
  return e;
}

function resolveTarget(t: string): FakeSession | undefined {
  if (t.startsWith('$')) return h.sessions.find(s => s.id === t);
  if (t.startsWith('=')) return h.sessions.find(s => s.name === t.slice(1));
  const exact = h.sessions.find(s => s.name === t);
  if (exact) return exact;
  const prefixed = h.sessions.filter(s => s.name.startsWith(t));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

function out(value: string, opts: { encoding?: string } | undefined): string | Buffer {
  return opts && opts.encoding ? value : Buffer.from(value);
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const fake = (cmd: string, args: string[] = [], opts?: { encoding?: string }) => {
    if (cmd === 'tmux') {
      h.calls.push({ cmd, args: [...args] });
      if (h.tmuxOverride) {
        const r = h.tmuxOverride(args);
        if (r.handled) return out(r.value ?? '', opts);
      }
      const sub = args[0];
      if (h.sessions.length === 0) throw tmuxErr('no server running on /private/tmp/tmux-501/default');
      if (sub === 'list-sessions') {
        const fmt = args[args.indexOf('-F') + 1];
        const lines = h.sessions.map(s =>
          fmt.replace('#{session_id}', s.id).replace('#{session_name}', s.name).replace('#{session_path}', s.path),
        );
        return out(lines.join('\n') + '\n', opts);
      }
      const t = args[args.indexOf('-t') + 1];
      const s = resolveTarget(t);
      if (!s) throw tmuxErr(`can't find session: ${t}`);
      if (sub === 'kill-session') {
        if (!h.unkillable.has(s.id)) {
          h.sessions = h.sessions.filter(x => x !== s);
          h.afterKill?.(s);
        }
        return out('', opts);
      }
      if (sub === 'has-session') return out('', opts);
      throw tmuxErr(`unknown command: ${sub}`);
    }
    if (cmd === 'launchctl') {
      h.calls.push({ cmd, args: [...args] });
      const sub = args[0];
      if (sub === 'print') {
        if (h.launchd.printError) throw Object.assign(new Error('print failed'), { stderr: Buffer.from(h.launchd.printError.stderr), status: h.launchd.printError.status });
        if (!h.launchd.loaded) throw Object.assign(new Error('not found'), { stderr: Buffer.from('Bad request.\nCould not find service "x" in domain for user gui: 501\n'), status: 113 });
        return out('service = {\n}\n', opts);
      }
      if (sub === 'list') {
        if (h.launchd.listError) throw Object.assign(new Error('list failed'), { stderr: Buffer.from(h.launchd.listError.stderr), status: h.launchd.listError.status });
        if (!h.launchd.loaded) throw Object.assign(new Error('not found'), { stderr: Buffer.from('Could not find service "x" in domain for port\n'), status: 113 });
        return out(h.launchd.listOutput ?? '', opts);
      }
      if (sub === 'bootout') {
        if (!h.launchd.bootoutLeavesLoaded) h.launchd.loaded = false;
        return out('', opts);
      }
      throw new Error(`unexpected launchctl ${sub}`);
    }
    if (cmd === 'plutil') {
      h.calls.push({ cmd, args: [...args] });
      if (h.launchd.plutilError) throw Object.assign(new Error('plutil failed'), { stderr: Buffer.from(h.launchd.plutilError), status: 1 });
      const file = args[args.length - 1];
      return out(fs.readFileSync(file, 'utf-8'), opts);
    }
    if (cmd === 'systemctl') {
      h.calls.push({ cmd, args: [...args] });
      const sub = args[1];
      if (sub === 'show') {
        if (h.systemd.showError) throw Object.assign(new Error('show failed'), { stderr: Buffer.from(h.systemd.showError), status: 1 });
        return out(h.systemd.showOutput, opts);
      }
      if (sub === 'stop') {
        if (h.systemd.stopError) throw Object.assign(new Error('stop failed'), { stderr: Buffer.from(h.systemd.stopError), status: 1 });
        return out('', opts);
      }
      if (sub === 'disable') {
        if (h.systemd.disableError) throw Object.assign(new Error('disable failed'), { stderr: Buffer.from(h.systemd.disableError), status: 1 });
        return out('', opts);
      }
      if (sub === 'daemon-reload') return out('', opts);
      if (sub === 'is-active') {
        if (h.systemd.isActive === 'active') return out('active\n', opts);
        throw Object.assign(new Error('inactive'), { stdout: Buffer.from(h.systemd.isActive + '\n'), stderr: Buffer.from(''), status: 3 });
      }
      throw new Error(`unexpected systemctl ${sub}`);
    }
    return (real.execFileSync as unknown as (...a: unknown[]) => unknown)(cmd, args, opts);
  };
  return { ...real, default: { ...real, execFileSync: fake }, execFileSync: fake };
});

vi.mock('../../src/commands/setup.js', () => ({
  uninstallAutoStart: vi.fn(() => false),
}));

vi.mock('../../src/core/SecretManager.js', () => ({
  SecretManager: class { initialize() {} backupFromConfig() {} },
  SECRET_KEYS: {},
}));

vi.mock('../../src/core/AgentRegistry.js', () => ({
  unregisterAgent: vi.fn((p: string) => { h.unregister?.(p); }),
}));

vi.mock('../../src/core/Config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/Config.js')>();
  return { ...real, standaloneAgentsDir: () => path.join(h.home, '.instar', 'agents') };
});

import {
  nukeAgent,
  nukeHere,
  isPathInside,
  placeSession,
  parseSessionListing,
  parseLaunchctlList,
  classifyEntry,
  matchesNameRule,
} from '../../src/commands/nuke.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { unregisterAgent } from '../../src/core/AgentRegistry.js';

// ── Sandbox ─────────────────────────────────────────────────────────

let prevHome: string | undefined;
let prevAudit: string | undefined;
let prevRegistryDir: string | undefined;
let logs: string[];
let prevPlatform: PropertyDescriptor | undefined;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function makeHome(agentsDir: string, name: string, projectName = name): string {
  const dir = path.join(agentsDir, name);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName }));
  return fs.realpathSync(dir);
}

function addSession(name: string, startDir: string): FakeSession {
  const s = { id: `$${h.nextId++}`, name, path: startDir };
  h.sessions.push(s);
  return s;
}

function exitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
}

beforeEach(() => {
  prevHome = process.env.HOME;
  prevAudit = process.env.INSTAR_AUDIT_LOG_DIR;
  prevRegistryDir = process.env.INSTAR_TEST_REGISTRY_DIR;
  h.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-nuke-home-')));
  process.env.HOME = h.home;
  process.env.INSTAR_AUDIT_LOG_DIR = path.join(h.home, 'audit');
  delete process.env.INSTAR_TEST_REGISTRY_DIR;
  h.sessions = [];
  h.nextId = 1;
  h.calls = [];
  h.tmuxOverride = null;
  h.afterKill = null;
  h.unkillable = new Set();
  h.launchd = { loaded: false, printError: null, listOutput: null, listError: null, bootoutLeavesLoaded: false, plutilError: null };
  h.systemd = { showOutput: '', showError: null, stopError: null, disableError: null, isActive: 'inactive' };
  h.unregister = null;
  logs = [];
  prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  setPlatform('darwin');
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevPlatform) Object.defineProperty(process, 'platform', prevPlatform);
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevAudit === undefined) delete process.env.INSTAR_AUDIT_LOG_DIR; else process.env.INSTAR_AUDIT_LOG_DIR = prevAudit;
  if (prevRegistryDir !== undefined) process.env.INSTAR_TEST_REGISTRY_DIR = prevRegistryDir;
  SafeFsExecutor.safeRmSync(h.home, { recursive: true, force: true, operation: 'tests/unit/nuke-teardown-narrowing.test.ts:cleanup' });
});

// ── Reproduction (fb-7e502374-a36) ──────────────────────────────────

describe('reproduction: nuking zz-echo must not stop zz-echo-wt-1', () => {
  it('stops zz-echo-server and leaves zz-echo-wt-1-server running (unregistered sibling home)', async () => {
    const agents = path.join(h.home, '.instar', 'agents');
    const echo = makeHome(agents, 'zz-echo');
    const wt = makeHome(agents, 'zz-echo-wt-1');
    addSession('zz-echo-server', echo);
    addSession('zz-echo-wt-1-server', wt);

    await nukeAgent('zz-echo', { skipConfirm: true });

    const names = h.sessions.map(s => s.name);
    expect(names).not.toContain('zz-echo-server');
    expect(names).toContain('zz-echo-wt-1-server');
    expect(fs.existsSync(echo)).toBe(false);
    expect(fs.existsSync(wt)).toBe(true);
  });
});

// ── Helpers for the rest of the suite ───────────────────────────────

const agentsDir = () => path.join(h.home, '.instar', 'agents');

async function run(fn: () => Promise<void>): Promise<number> {
  const spy = exitSpy();
  try {
    await fn();
    return 0;
  } catch (err) {
    const m = /^exit:(\d+)$/.exec((err as Error).message);
    if (m) return Number(m[1]);
    throw err;
  } finally {
    spy.mockRestore();
  }
}

const nuke = (name: string, alsoStop?: string[]) => run(() => nukeAgent(name, { skipConfirm: true, alsoStop }));

function tmuxCalls(sub: string): string[][] {
  return h.calls.filter(c => c.cmd === 'tmux' && c.args[0] === sub).map(c => c.args);
}
function killTargets(): string[] {
  return tmuxCalls('kill-session').map(a => a[a.indexOf('-t') + 1]);
}
function alive(name: string): boolean {
  return h.sessions.some(s => s.name === name);
}
function writeRegistry(paths: string[]): void {
  fs.mkdirSync(path.join(h.home, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(h.home, '.instar', 'registry.json'), JSON.stringify({
    version: 1, entries: paths.map(p => ({ path: p, name: path.basename(p) })),
  }));
}
function mkdir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync(p);
}
function plistPath(project: string): string {
  return path.join(h.home, 'Library', 'LaunchAgents', `ai.instar.${project}.plist`);
}
/** The fake `plutil -convert json` returns the file as-is, so the fixture file holds the JSON form. */
function writePlist(project: string, fields: { WorkingDirectory?: string; ProgramArguments?: string[] }): string {
  const p = plistPath(project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ Label: `ai.instar.${project}`, ...fields }));
  return p;
}
/** Shape of real `launchctl list <label>` output (captured on macOS 26, paths replaced). */
function launchctlListFixture(label: string, args?: string[]): string {
  const argBlock = args
    ? `\t"ProgramArguments" = (\n${args.map(a => `\t\t"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";`).join('\n')}\n\t);\n`
    : '';
  return `{\n\t"StandardOutPath" = "/x/logs/lifeline-launchd.log";\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "${label}";\n\t"OnDemand" = false;\n\t"LastExitStatus" = 0;\n\t"PID" = 21555;\n\t"Program" = "/x/.instar/bin/node";\n${argBlock}};\n`;
}
function loadJob(project: string, args?: string[]): void {
  h.launchd.loaded = true;
  h.launchd.listOutput = launchctlListFixture(`ai.instar.${project}`, args);
}
const lifelineArgs = (dir: string) => ['/x/.instar/bin/node', '/x/.instar/bin/boot.js', 'lifeline', 'start', '--dir', dir];

// ── Session rule ────────────────────────────────────────────────────

describe('session rule (spec §1)', () => {
  it('compares paths component by component', () => {
    expect(isPathInside('/a/agents/echo-wt-1', '/a/agents/echo')).toBe(false);
    expect(isPathInside('/a/agents/echo/x', '/a/agents/echo')).toBe(true);
    expect(isPathInside('/a/agents/echo', '/a/agents/echo')).toBe(true);
    expect(isPathInside('/a/..hidden', '/a')).toBe(true);
    expect(isPathInside('/a', '/a/b')).toBe(false);
    expect(matchesNameRule('zz-echo-wt-1-server', 'zz-echo')).toBe(true); // today's rule still selects it…
    expect(placeSession('/a/agents/zz-echo-wt-1', '/a/agents/zz-echo', ['/a/agents/zz-echo-wt-1']).kind).toBe('other-home'); // …placement skips it
  });

  it('stops a session inside H, including H/.instar/worktrees/x', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const wt = mkdir(path.join(H, '.instar', 'worktrees', 'x'));
    addSession('zz-echo-server', H);
    addSession('zz-echo-topic-1', wt);
    expect(await nuke('zz-echo')).toBe(0);
    expect(alive('zz-echo-topic-1')).toBe(false);
    expect(fs.existsSync(H)).toBe(false);
  });

  it('skips and prints a session in a registered sibling home outside the agents folder', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const proj = mkdir(path.join(h.home, 'projects', 'zz-echo-proj'));
    fs.mkdirSync(path.join(proj, '.instar'));
    fs.writeFileSync(path.join(proj, '.instar', 'config.json'), '{}');
    writeRegistry([proj]);
    addSession('zz-echo-server', H);
    addSession('zz-echo-proj-server', proj);
    expect(await nuke('zz-echo')).toBe(0);
    expect(alive('zz-echo-proj-server')).toBe(true);
    expect(logs.join('\n')).toMatch(/Left running.*zz-echo-proj-server/);
  });

  it('never skips because of a stale registry entry or one above H (they refuse as ambiguous instead)', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    fs.mkdirSync(path.join(h.home, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(h.home, '.instar', 'config.json'), '{}'); // makes HOME look like a home, above H
    const elsewhere = mkdir(path.join(h.home, 'elsewhere'));
    writeRegistry([h.home, path.join(h.home, 'gone')]);
    addSession('zz-echo-server', H);
    addSession('zz-echo-helper', elsewhere);
    addSession('zz-echo-stale', path.join(h.home, 'gone', 'x'));
    expect(await nuke('zz-echo')).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(fs.existsSync(H)).toBe(true);
    expect(logs.join('\n')).toMatch(/zz-echo-helper/);
    expect(logs.join('\n')).toMatch(/zz-echo-stale/);
  });

  it('--also-stop stops exactly the listed ambiguous ids', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const wt = makeHome(agentsDir(), 'zz-echo-wt-1');
    const scratch = mkdir(path.join(h.home, 'scratch'));
    addSession('zz-echo-server', H);
    const helper = addSession('zz-echo-helper', scratch);
    addSession('zz-echo-wt-1-server', wt);
    expect(await nuke('zz-echo', [helper.id.slice(1)])).toBe(0);
    expect(alive('zz-echo-helper')).toBe(false);
    expect(alive('zz-echo-wt-1-server')).toBe(true);
  });

  it('--also-stop refuses an id that is not on the ambiguous list', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const scratch = mkdir(path.join(h.home, 'scratch'));
    addSession('zz-echo-server', H);
    const helper = addSession('zz-echo-helper', scratch);
    const server = h.sessions[0];
    expect(await nuke('zz-echo', [helper.id, server.id])).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(fs.existsSync(H)).toBe(true);
  });

  it('a replacement server in the second list refuses the deletes', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    h.afterKill = (k) => { if (k.name === 'zz-echo-server') { h.afterKill = null; addSession('zz-echo-server', H); } };
    expect(await nuke('zz-echo')).toBe(1);
    expect(alive('zz-echo-server')).toBe(true); // the replacement was not stopped
    expect(fs.existsSync(H)).toBe(true);
    expect(vi.mocked(unregisterAgent)).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toMatch(/has been removed/);
  });

  it('a failed listing refuses before teardown', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    h.tmuxOverride = (args) => {
      if (args[0] === 'list-sessions') throw tmuxErr('error connecting to /private/tmp/tmux-501/default (Permission denied)');
      return { handled: false };
    };
    expect(await nuke('zz-echo')).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(fs.existsSync(H)).toBe(true);
  });

  it('"no server running" is an empty list: an offline agent is removable', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    expect(await nuke('zz-echo')).toBe(0);
    expect(fs.existsSync(H)).toBe(false);
    expect(logs.join('\n')).toMatch(/has been removed/);
  });

  it('a single-session agent finishes after its last session stops (the tmux server exits)', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    expect(await nuke('zz-echo')).toBe(0);
    expect(h.sessions).toEqual([]);
    expect(fs.existsSync(H)).toBe(false);
  });

  it('a new in-home worker in the second list is stopped by its second-list id', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    let late: FakeSession | null = null;
    h.afterKill = (k) => { if (k.name === 'zz-echo-server') { h.afterKill = null; late = addSession('zz-echo-topic-9', H); } };
    expect(await nuke('zz-echo')).toBe(0);
    expect(late).not.toBeNull();
    expect(killTargets()).toContain(late!.id);
    expect(alive('zz-echo-topic-9')).toBe(false);
  });

  it('a worker in both lists is stopped by its second-list id', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    const worker = addSession('zz-echo-topic-1', H);
    expect(await nuke('zz-echo')).toBe(0);
    expect(killTargets()).toEqual(['$1', worker.id]);
  });

  it('of two ambiguous sessions with only one approved, nothing is torn down', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const scratch = mkdir(path.join(h.home, 'scratch'));
    addSession('zz-echo-server', H);
    const a = addSession('zz-echo-a', scratch);
    addSession('zz-echo-b', scratch);
    expect(await nuke('zz-echo', [a.id])).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(fs.existsSync(H)).toBe(true);
  });

  it('a new ambiguous session in the second list refuses the deletes and prints the partial state', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const scratch = mkdir(path.join(h.home, 'scratch'));
    addSession('zz-echo-server', H);
    h.afterKill = (k) => { if (k.name === 'zz-echo-server') { h.afterKill = null; addSession('zz-echo-late', scratch); } };
    expect(await nuke('zz-echo')).toBe(1);
    expect(alive('zz-echo-late')).toBe(true);
    expect(fs.existsSync(H)).toBe(true);
    const out = logs.join('\n');
    expect(out).toMatch(/Stopped zz-echo-server \(\$1\)/);
    expect(out).toMatch(/--also-stop/);
    expect(out).not.toMatch(/has been removed/);
  });

  it('an unreadable registry refuses, even for an offline agent', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    fs.writeFileSync(path.join(h.home, '.instar', 'registry.json'), '{not json');
    expect(await nuke('zz-echo')).toBe(1);
    expect(fs.existsSync(H)).toBe(true);
  });

  it('a sibling folder without .instar does not count as a home', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const stray = mkdir(path.join(agentsDir(), 'zz-echo-stray'));
    addSession('zz-echo-server', H);
    addSession('zz-echo-stray-x', stray);
    expect(await nuke('zz-echo')).toBe(1); // ambiguous, not skipped
    expect(killTargets()).toEqual([]);
    expect(logs.join('\n')).toMatch(/zz-echo-stray-x[\s\S]*--also-stop/);
  });

  it('a stop that leaves the session alive refuses unregister and the deletes', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const server = addSession('zz-echo-server', H);
    h.unkillable.add(server.id);
    expect(await nuke('zz-echo')).toBe(1);
    expect(fs.existsSync(H)).toBe(true);
    expect(vi.mocked(unregisterAgent)).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/still running/);
  });

  it('a permission error from has-session after a failed kill keeps the home and exits non-zero', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    h.tmuxOverride = (args) => {
      if (args[0] === 'kill-session' || args[0] === 'has-session') throw tmuxErr('error connecting to /private/tmp/tmux-501/default (Permission denied)');
      return { handled: false };
    };
    expect(await nuke('zz-echo')).toBe(1);
    expect(fs.existsSync(H)).toBe(true);
    expect(vi.mocked(unregisterAgent)).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/could not confirm/);
  });

  it('a home-less name match refuses before teardown with no call made', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const scratch = mkdir(path.join(h.home, 'scratch'));
    addSession('zz-echo-server', H);
    addSession('zz-echo-helper', scratch);
    loadJob('zz-echo', lifelineArgs(H));
    writePlist('zz-echo', { WorkingDirectory: H, ProgramArguments: lifelineArgs(H) });
    expect(await nuke('zz-echo')).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(h.calls.some(c => c.cmd === 'launchctl' && c.args[0] === 'bootout')).toBe(false);
    expect(fs.existsSync(plistPath('zz-echo'))).toBe(true);
    expect(fs.existsSync(H)).toBe(true);
    expect(logs.join('\n')).toMatch(/\$2\s+zz-echo-helper/);
  });

  it('a missing start folder is compared lexically', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    expect(placeSession(path.join(H, 'gone', 'sub'), H, []).kind).toBe('inside');
    expect(placeSession(path.join(h.home, 'gone'), H, []).kind).toBe('ambiguous');
    addSession('zz-echo-server', H);
    addSession('zz-echo-old', path.join(H, 'gone', 'sub'));
    expect(await nuke('zz-echo')).toBe(0);
    expect(alive('zz-echo-old')).toBe(false);
  });

  it('names and paths containing spaces parse correctly', async () => {
    expect(parseSessionListing('$1 zz echo-server\n$22 zz-x\n', '$1 /a b/c d\n$22 \n')).toEqual([
      { id: '$1', name: 'zz echo-server', path: '/a b/c d' },
      { id: '$22', name: 'zz-x', path: '' },
    ]);
    expect(() => parseSessionListing('garbage line', '')).toThrow();
    expect(() => parseSessionListing('$1 a\n$2 b\n', '$1 /x\n')).toThrow(); // listings disagree
    const H = makeHome(agentsDir(), 'zz-sp ace');
    const other = makeHome(agentsDir(), 'zz-sp ace-two');
    addSession('zz-sp ace-server', H);
    addSession('zz-sp ace-two-server', other);
    expect(await nuke('zz-sp ace')).toBe(0);
    expect(alive('zz-sp ace-two-server')).toBe(true);
    expect(fs.existsSync(H)).toBe(false);
  });

  it('a registered home nested in H refuses', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const inner = makeHome(path.join(H, 'sub'), 'zz-inner');
    writeRegistry([inner]);
    expect(await nuke('zz-echo')).toBe(1);
    expect(fs.existsSync(H)).toBe(true);
    expect(logs.join('\n')).toMatch(/inside/);
  });

  it('an unregistered folder holding .instar/config.json inside H refuses', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    makeHome(path.join(H, 'nested'), 'zz-inner');
    expect(await nuke('zz-echo')).toBe(1);
    expect(fs.existsSync(H)).toBe(true);
  });

  it('property: the stopped set is never larger than the old prefix rule', async () => {
    const layouts: Array<Array<[string, 'H' | 'wt' | 'scratch' | 'other']>> = [
      [['zz-echo-server', 'H'], ['zz-echo-wt-1-server', 'wt'], ['zz-echo-topic-1', 'H'], ['zz-other-server', 'other']],
      [['zz-echo-server', 'H'], ['zz-echoes-server', 'H'], ['zz-echo-wt-1-x', 'wt']],
      [['zz-echo-server', 'H'], ['zz-echo-helper', 'scratch']],
      [['zz-echo-wt-1-server', 'wt'], ['zz-echo-a', 'H'], ['zz-echo-b', 'H']],
    ];
    for (const layout of layouts) {
      SafeFsExecutor.safeRmSync(path.join(h.home, '.instar'), { recursive: true, force: true, operation: 'tests/unit/nuke-teardown-narrowing.test.ts:property-reset' });
      h.sessions = []; h.calls = []; h.nextId = 1;
      const H = makeHome(agentsDir(), 'zz-echo');
      const dirs = { H, wt: makeHome(agentsDir(), 'zz-echo-wt-1'), scratch: mkdir(path.join(h.home, 'scratch')), other: makeHome(agentsDir(), 'zz-other') };
      for (const [name, where] of layout) addSession(name, dirs[where]);
      const oldRule = new Set(h.sessions.filter(s => s.name.startsWith('zz-echo-')).map(s => s.id));
      const before = new Set(h.sessions.map(s => s.id));
      await nuke('zz-echo', ['3']);
      const stopped = [...before].filter(id => !h.sessions.some(s => s.id === id));
      for (const id of stopped) expect(oldRule.has(id)).toBe(true);
    }
  });
});

// ── Targets ─────────────────────────────────────────────────────────

describe('exact tmux targets (spec §2)', () => {
  it('stops use the recorded $N id and lookups never use a bare name', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    addSession('zz-echo-topic-1', H);
    expect(await nuke('zz-echo')).toBe(0);
    for (const t of killTargets()) expect(t).toMatch(/^\$\d+$/);
    for (const c of h.calls.filter(c => c.cmd === 'tmux' && c.args.includes('-t'))) {
      expect(c.args[c.args.indexOf('-t') + 1]).toMatch(/^(\$\d+|=.+)$/);
    }
  });

  it('a same-name session created after planning in another home survives', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const wt = makeHome(agentsDir(), 'zz-echo-wt-1');
    addSession('zz-echo-server', H);
    const worker = addSession('zz-echo-topic-1', H);
    h.afterKill = (k) => {
      if (k.name !== 'zz-echo-server') return;
      h.afterKill = null;
      h.sessions = h.sessions.filter(s => s.id !== worker.id); // the planned worker exits…
      addSession('zz-echo-topic-1', wt); // …and a same-named one starts elsewhere
    };
    expect(await nuke('zz-echo')).toBe(0);
    expect(alive('zz-echo-topic-1')).toBe(true);
  });
});

// ── Auto-start entry ────────────────────────────────────────────────

describe('auto-start entry (spec §3)', () => {
  it('parses a real-shaped `launchctl list <label>` fixture, and refuses on a parse failure', async () => {
    const parsed = parseLaunchctlList(launchctlListFixture('ai.instar.zz-echo', ['/n', '/b.js', 'lifeline', 'start', '--dir', '/p "q"/r']));
    expect(parsed.label).toBe('ai.instar.zz-echo');
    expect(parsed.programArguments).toEqual(['/n', '/b.js', 'lifeline', 'start', '--dir', '/p "q"/r']);
    expect(parseLaunchctlList(launchctlListFixture('ai.instar.zz-echo')).programArguments).toBeUndefined();
    expect(() => parseLaunchctlList('Could not find service')).toThrow();

    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    h.launchd.loaded = true;
    h.launchd.listOutput = '{\n\t"ProgramArguments" = (\n\t\t"/n"\n};\n';
    expect(await nuke('zz-echo')).toBe(1);
    expect(killTargets()).toEqual([]);
  });

  it('file and loaded job both pointing at H: removed before any session stop, with print verified', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    writePlist('zz-echo', { WorkingDirectory: H, ProgramArguments: lifelineArgs(H) });
    loadJob('zz-echo', lifelineArgs(H));
    expect(await nuke('zz-echo')).toBe(0);
    const order = h.calls.map(c => `${c.cmd} ${c.args[0]}`);
    const bootout = order.indexOf('launchctl bootout');
    expect(bootout).toBeGreaterThan(-1);
    expect(order.indexOf('tmux kill-session')).toBeGreaterThan(bootout);
    expect(order.slice(bootout + 1).indexOf('launchctl print')).toBeGreaterThan(-1);
    expect(fs.existsSync(plistPath('zz-echo'))).toBe(false);
    expect(h.launchd.loaded).toBe(false);
  });

  it('a file-only entry pointing at H is removed', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    writePlist('zz-echo', { WorkingDirectory: H, ProgramArguments: lifelineArgs(H) });
    expect(await nuke('zz-echo')).toBe(0);
    expect(fs.existsSync(plistPath('zz-echo'))).toBe(false);
    expect(h.calls.some(c => c.cmd === 'launchctl' && c.args[0] === 'bootout')).toBe(false);
  });

  it('a loaded-only entry pointing at H is booted out', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    loadJob('zz-echo', lifelineArgs(H));
    expect(await nuke('zz-echo')).toBe(0);
    expect(h.launchd.loaded).toBe(false);
  });

  it('a matching file with a foreign loaded job: both untouched', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const other = mkdir(path.join(h.home, 'zz-elsewhere'));
    writePlist('zz-echo', { WorkingDirectory: H, ProgramArguments: lifelineArgs(H) });
    loadJob('zz-echo', lifelineArgs(other));
    expect(await nuke('zz-echo')).toBe(0);
    expect(fs.existsSync(plistPath('zz-echo'))).toBe(true);
    expect(h.launchd.loaded).toBe(true);
    expect(logs.join('\n')).toMatch(/left in place/);
  });

  it('a loaded job pointing at H with a file pointing elsewhere refuses before teardown', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const other = mkdir(path.join(h.home, 'zz-elsewhere'));
    addSession('zz-echo-server', H);
    writePlist('zz-echo', { WorkingDirectory: other, ProgramArguments: lifelineArgs(other) });
    loadJob('zz-echo', lifelineArgs(H));
    expect(await nuke('zz-echo')).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(h.launchd.loaded).toBe(true);
    expect(fs.existsSync(plistPath('zz-echo'))).toBe(true);
  });

  it('an internally conflicting loaded entry refuses', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    loadJob('zz-echo', [...lifelineArgs(H), '--dir', path.join(h.home, 'zz-elsewhere')]);
    expect(await nuke('zz-echo')).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(classifyEntry({ workingDirectory: H, args: ['--dir', '/zz-else'] }, H)).toBe('conflict');
  });

  it('still loaded after bootout: the command stops with no session stopped', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    writePlist('zz-echo', { WorkingDirectory: H, ProgramArguments: lifelineArgs(H) });
    loadJob('zz-echo', lifelineArgs(H));
    h.launchd.bootoutLeavesLoaded = true;
    expect(await nuke('zz-echo')).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(fs.existsSync(H)).toBe(true);
    expect(fs.existsSync(plistPath('zz-echo'))).toBe(true);
  });

  it('an entry pointing elsewhere is untouched and printed', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    const other = mkdir(path.join(h.home, 'zz-elsewhere'));
    writePlist('zz-echo', { WorkingDirectory: other, ProgramArguments: lifelineArgs(other) });
    expect(await nuke('zz-echo')).toBe(0);
    expect(fs.existsSync(plistPath('zz-echo'))).toBe(true);
    expect(logs.join('\n')).toMatch(/ai\.instar\.zz-echo left in place/);
  });

  it('an entry with neither WorkingDirectory nor --dir is kept', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    writePlist('zz-echo', { ProgramArguments: ['/x/node', '/x/boot.js', 'server', 'start'] });
    expect(await nuke('zz-echo')).toBe(0);
    expect(fs.existsSync(plistPath('zz-echo'))).toBe(true);
    expect(fs.existsSync(H)).toBe(false);
  });

  it('a failed launchctl print refuses', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    addSession('zz-echo-server', H);
    h.launchd.printError = { status: 5, stderr: 'Operation not permitted' };
    expect(await nuke('zz-echo')).toBe(1);
    expect(killTargets()).toEqual([]);
    expect(fs.existsSync(H)).toBe(true);
  });

  it('an unreadable plist refuses', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    writePlist('zz-echo', { WorkingDirectory: H });
    h.launchd.plutilError = 'Property List error: Unexpected character';
    expect(await nuke('zz-echo')).toBe(1);
    expect(fs.existsSync(H)).toBe(true);
  });

  describe('Linux', () => {
    const unitPath = () => path.join(h.home, '.config', 'systemd', 'user', 'instar-zz-echo.service');
    function writeUnit(dir: string): void {
      fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
      fs.writeFileSync(unitPath(), `[Service]\nExecStart=/bin/bash ${dir}/.instar/bin/boot.sh lifeline start --dir ${dir}\nWorkingDirectory=${dir}\n`);
    }
    function showFixture(dir: string, needReload = 'no'): string {
      return [
        'LoadState=loaded',
        'ActiveState=active',
        `WorkingDirectory=${dir}`,
        `ExecStart={ path=/bin/bash ; argv[]=/bin/bash ${dir}/.instar/bin/boot.sh lifeline start --dir ${dir} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
        `NeedDaemonReload=${needReload}`,
        '',
      ].join('\n');
    }
    beforeEach(() => { setPlatform('linux'); });

    it('NeedDaemonReload=yes refuses (systemctl show fixture)', async () => {
      const H = makeHome(agentsDir(), 'zz-echo');
      addSession('zz-echo-server', H);
      writeUnit(H);
      h.systemd.showOutput = showFixture(H, 'yes');
      expect(await nuke('zz-echo')).toBe(1);
      expect(killTargets()).toEqual([]);
      expect(fs.existsSync(unitPath())).toBe(true);
    });

    it('a matching unit is stopped, disabled, deleted and confirmed inactive', async () => {
      const H = makeHome(agentsDir(), 'zz-echo');
      addSession('zz-echo-server', H);
      writeUnit(H);
      h.systemd.showOutput = showFixture(H);
      expect(await nuke('zz-echo')).toBe(0);
      const subs = h.calls.filter(c => c.cmd === 'systemctl').map(c => c.args[1]);
      expect(subs).toEqual(['show', 'stop', 'disable', 'daemon-reload', 'is-active']);
      expect(fs.existsSync(unitPath())).toBe(false);
    });

    it('a failed stop is checked on its own and stops the command before any session stop', async () => {
      const H = makeHome(agentsDir(), 'zz-echo');
      addSession('zz-echo-server', H);
      writeUnit(H);
      h.systemd.showOutput = showFixture(H);
      h.systemd.stopError = 'Failed to stop';
      expect(await nuke('zz-echo')).toBe(1);
      expect(killTargets()).toEqual([]);
      expect(h.calls.some(c => c.cmd === 'systemctl' && c.args[1] === 'disable')).toBe(false);
    });

    it('a failed disable is checked on its own', async () => {
      const H = makeHome(agentsDir(), 'zz-echo');
      addSession('zz-echo-server', H);
      writeUnit(H);
      h.systemd.showOutput = showFixture(H);
      h.systemd.disableError = 'Failed to disable';
      expect(await nuke('zz-echo')).toBe(1);
      expect(killTargets()).toEqual([]);
      expect(fs.existsSync(unitPath())).toBe(true);
    });
  });
});

// ── Preconditions and plan ──────────────────────────────────────────

describe('preconditions and plan (spec §4)', () => {
  it('a symlinked home is refused before teardown', async () => {
    const real = makeHome(path.join(h.home, 'real'), 'zz-target');
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.symlinkSync(real, path.join(agentsDir(), 'zz-link'));
    expect(await nuke('zz-link')).toBe(1);
    expect(fs.existsSync(path.join(real, '.instar', 'config.json'))).toBe(true);
  });

  it('a bad or empty name is refused', async () => {
    makeHome(agentsDir(), 'zz-echo');
    for (const bad of ['', '.', '..', 'zz-echo/..', 'a\0b']) {
      expect(await nuke(bad)).toBe(1);
    }
    expect(fs.existsSync(agentsDir())).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), 'zz-echo'))).toBe(true);
  });

  function seedProject(): string {
    const dir = mkdir(path.join(h.home, 'zz-proj'));
    fs.mkdirSync(path.join(dir, '.instar'));
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName: 'zz-proj' }));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# instar-created\n');
    return dir;
  }

  it('every nukeHere delete is pre-checked with its real flags', async () => {
    const dir = seedProject();
    const spy = vi.spyOn(SafeFsExecutor, 'checkScope');
    expect(await run(() => nukeHere({ dir, skipConfirm: true }))).toBe(0);
    const seen = spy.mock.calls.map(([t, o]) => [path.basename(t), o?.recursive, o?.force]);
    expect(seen).toEqual([
      ['.instar', true, true],
    ]);
  });

  it('a refused delete changes nothing', async () => {
    const dir = seedProject();
    addSession('zz-proj-server', dir);
    const real = SafeFsExecutor.checkScope.bind(SafeFsExecutor);
    vi.spyOn(SafeFsExecutor, 'checkScope').mockImplementation((t, o) =>
      path.basename(t) === '.instar'
        ? { allowed: false, canonical: t, reason: 'test refusal', error: new Error('test refusal') }
        : real(t, o));
    expect(await run(() => nukeHere({ dir, skipConfirm: true }))).toBe(1);
    expect(killTargets()).toEqual([]);
    for (const rel of ['.instar', '.claude', '.mcp.json', 'CLAUDE.md']) expect(fs.existsSync(path.join(dir, rel))).toBe(true);
    expect(logs.join('\n')).toMatch(/\.instar: test refusal/);
  });

  it('an unregistered foreign home under H/.instar/agents/ refuses --here', async () => {
    const dir = seedProject();
    mkdir(path.join(dir, '.instar', 'agents', 'zz-foreign'));
    expect(await run(() => nukeHere({ dir, skipConfirm: true }))).toBe(1);
    expect(fs.existsSync(path.join(dir, '.instar', 'agents', 'zz-foreign'))).toBe(true);
  });

  it('for nukeHere, a registered home under H/.instar refuses', async () => {
    const dir = seedProject();
    const inner = mkdir(path.join(dir, '.instar', 'worktrees', 'x'));
    writeRegistry([inner]);
    fs.mkdirSync(path.join(inner, '.instar'));
    fs.writeFileSync(path.join(inner, '.instar', 'config.json'), '{}');
    expect(await run(() => nukeHere({ dir, skipConfirm: true }))).toBe(1);
    expect(fs.existsSync(path.join(inner, '.instar', 'config.json'))).toBe(true);
  });
});

// ── Result ──────────────────────────────────────────────────────────

describe('honest result (spec §5)', () => {
  it('a partial teardown repeats kept paths and the review offer', async () => {
    const dir = makeHome(h.home, 'zz-proj');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'keep me');
    h.unregister = () => { throw new Error('registry locked'); };
    expect(await run(() => nukeHere({ dir, skipConfirm: true }))).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('keep me');
    expect(logs.filter(l => l.includes('Your agent can review these files read-only'))).toHaveLength(2);
    expect(logs.filter(l => l.includes('- CLAUDE.md'))).toHaveLength(2);
    expect(logs.join('\n')).not.toMatch(/has been removed/);
  });

  it('a stop failure repeats the kept-path notice before reporting failure', async () => {
    const dir = makeHome(h.home, 'zz-proj');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'keep');
    const session = addSession('zz-proj-server', dir);
    h.unkillable.add(session.id);
    expect(await run(() => nukeHere({ dir, skipConfirm: true }))).toBe(1);
    expect(logs.filter(l => l.includes('Your agent can review these files read-only'))).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, '.instar'))).toBe(true);
  });

  it('a failed unregister is reported', async () => {
    makeHome(agentsDir(), 'zz-echo');
    h.unregister = () => { throw new Error('registry locked'); };
    expect(await nuke('zz-echo')).toBe(1);
    expect(logs.join('\n')).toMatch(/unregister — .*registry locked/);
    expect(logs.join('\n')).not.toMatch(/has been removed/);
  });

  it('an absent registration is not a failure', async () => {
    const H = makeHome(agentsDir(), 'zz-echo');
    expect(await nuke('zz-echo')).toBe(0);
    expect(fs.existsSync(H)).toBe(false);
  });
});
