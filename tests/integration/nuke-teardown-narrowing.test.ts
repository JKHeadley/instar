/**
 * Integration (real tmux) for docs/specs/nuke-teardown-narrowing.md.
 *
 * SANDBOX: this test runs its OWN tmux server. `TMUX_TMPDIR` points at a temp
 * folder and `TMUX` is unset, so every tmux call (the test's and nuke's) talks
 * to `<tmp>/tmux-<uid>/default`, never the default server. HOME is a temp
 * folder. launchctl / plutil / systemctl are faked (an absent auto-start
 * entry); SecretManager, AgentRegistry, ./setup.js and standaloneAgentsDir are
 * mocked. Only `zz-nt` names are used. At the end the test kills only its own
 * server, by explicit socket path.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync as realExecFileSync } from 'node:child_process';

const h = vi.hoisted(() => ({ home: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const notFound = () => Object.assign(new Error('not found'), {
    stderr: Buffer.from('Could not find service "x" in domain for user gui: 501\n'), status: 113,
  });
  const fake = (cmd: string, args: string[] = [], opts?: unknown) => {
    if (cmd === 'launchctl') throw notFound();
    if (cmd === 'systemctl') {
      // Linux CI (ubuntu-latest): report "no such unit" so nuke proceeds, as on a machine with no auto-start.
      const out = 'LoadState=not-found\nActiveState=inactive\nWorkingDirectory=\nExecStart=\nNeedDaemonReload=no\n';
      return (opts as { encoding?: string } | undefined)?.encoding ? out : Buffer.from(out);
    }
    if (cmd === 'plutil') throw new Error('sandbox: plutil must not run');
    return (real.execFileSync as unknown as (...a: unknown[]) => unknown)(cmd, args, opts);
  };
  return { ...real, default: { ...real, execFileSync: fake }, execFileSync: fake };
});
vi.mock('../../src/commands/setup.js', () => ({ uninstallAutoStart: vi.fn(() => false) }));
vi.mock('../../src/core/SecretManager.js', () => ({
  SecretManager: class { initialize() {} backupFromConfig() {} },
  SECRET_KEYS: {},
}));
vi.mock('../../src/core/AgentRegistry.js', () => ({ unregisterAgent: vi.fn() }));
vi.mock('../../src/core/Config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/Config.js')>();
  return { ...real, standaloneAgentsDir: () => path.join(h.home, '.instar', 'agents') };
});

import { nukeAgent } from '../../src/commands/nuke.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmuxTmp: string;
let socket: string;
const saved: Record<string, string | undefined> = {};

function tmux(args: string[]): string {
  // Explicit socket for the test's own calls: never the default server.
  return realExecFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function hasSession(name: string): boolean {
  try { tmux(['has-session', '-t', `=${name}`]); return true; } catch { return false; }
}

function makeHome(name: string): string {
  const dir = path.join(h.home, '.instar', 'agents', name);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName: name }));
  return fs.realpathSync(dir);
}

beforeAll(() => {
  for (const k of ['HOME', 'TMUX', 'TMUX_TMPDIR', 'INSTAR_AUDIT_LOG_DIR', 'INSTAR_TEST_REGISTRY_DIR']) saved[k] = process.env[k];
  h.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-nt-home-')));
  tmuxTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-nt-tmux-')));
  process.env.HOME = h.home;
  process.env.TMUX_TMPDIR = tmuxTmp;
  delete process.env.TMUX;
  delete process.env.INSTAR_TEST_REGISTRY_DIR;
  process.env.INSTAR_AUDIT_LOG_DIR = path.join(h.home, 'audit');
  socket = path.join(tmuxTmp, `tmux-${process.getuid?.() ?? 501}`, 'default');
});

afterAll(() => {
  try { tmux(['kill-server']); } catch { /* already gone */ }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  SafeFsExecutor.safeRmSync(h.home, { recursive: true, force: true, operation: 'tests/integration/nuke-teardown-narrowing.test.ts:cleanup' });
  SafeFsExecutor.safeRmSync(tmuxTmp, { recursive: true, force: true, operation: 'tests/integration/nuke-teardown-narrowing.test.ts:cleanup' });
});

describe('nuke on a real (isolated) tmux server', () => {
  it('nukeAgent("zz-nt") removes zz-nt and leaves zz-nt-two-server running', async () => {
    const nt = makeHome('zz-nt');
    const two = makeHome('zz-nt-two');
    // Sessions are started via TMUX_TMPDIR (exactly how nuke reaches tmux), then
    // the socket is checked to be the sandbox one before anything else happens.
    realExecFileSync('tmux', ['new-session', '-d', '-s', 'zz-nt-server', '-c', nt, 'sleep 600'], { stdio: 'pipe' });
    expect(fs.existsSync(socket)).toBe(true);
    tmux(['new-session', '-d', '-s', 'zz-nt-topic-1', '-c', nt, 'sleep 600']);
    tmux(['new-session', '-d', '-s', 'zz-nt-two-server', '-c', two, 'sleep 600']);
    expect(hasSession('zz-nt-server')).toBe(true);
    expect(hasSession('zz-nt-two-server')).toBe(true);

    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    let thrown: unknown = null;
    try {
      await nukeAgent('zz-nt', { skipConfirm: true });
    } catch (err) {
      thrown = err;
    } finally {
      exit.mockRestore();
    }

    const listing = (() => { try { return tmux(['list-sessions', '-F', '#{session_name}']); } catch (e) { return String(e); } })();
    console.log(`[nuke-integration] remaining sessions:\n${listing}`);
    console.log(`[nuke-integration] nuke threw: ${thrown ? String(thrown) : 'no'}`);

    expect(thrown).toBeNull();
    expect(hasSession('zz-nt-server')).toBe(false);
    expect(hasSession('zz-nt-topic-1')).toBe(false);
    expect(hasSession('zz-nt-two-server')).toBe(true);
    expect(fs.existsSync(nt)).toBe(false);
    expect(fs.existsSync(two)).toBe(true);
  });
});
