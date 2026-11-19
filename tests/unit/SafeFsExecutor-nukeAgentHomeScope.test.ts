// safe-git-allow: test file for the SafeFsExecutor nukeAgentHomeScope allowance; direct fs is fixture setup only.
/**
 * docs/specs/nuke-teardown-narrowing.md §4 — `SafeFsExecutor.checkScope` (side-effect-free) and
 * the exclusive `nukeAgentHomeScope` allowance, tested through `safeRmSync` itself.
 *
 * SANDBOX: HOME is a fresh temp folder per test (the guard builds the agent-home path from
 * os.homedir()), the audit log goes to a temp folder, and every name starts with `zz-`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor, isSingleComponentName } from '../../src/core/SafeFsExecutor.js';

let home: string;
let auditDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['HOME', 'INSTAR_AUDIT_LOG_DIR', 'INSTAR_AUDIT_LOG_DISABLED']) saved[k] = process.env[k];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-scope-home-')));
  auditDir = path.join(home, 'audit');
  process.env.HOME = home;
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
  delete process.env.INSTAR_AUDIT_LOG_DISABLED;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function agentHome(name: string, root = path.join(home, '.instar', 'agents')): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), '{}');
  return dir;
}

/** Make `dir` look like a checkout of the instar source (agent-mode home). */
function makeCheckout(dir: string): void {
  fs.writeFileSync(path.join(dir, '.instar-source-tree'), 'marker');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
}

const RF = { recursive: true, force: true, operation: 'test:nuke-scope' };

function rmAllowed(target: string, opts: Parameters<typeof SafeFsExecutor.safeRmSync>[1]): boolean {
  try {
    SafeFsExecutor.safeRmSync(target, opts);
    return true;
  } catch {
    return false;
  }
}

describe('isSingleComponentName', () => {
  it('accepts one non-empty component and rejects everything else', () => {
    expect(isSingleComponentName('zz-echo')).toBe(true);
    expect(isSingleComponentName('zz echo')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', '/a', 'a\0b', undefined, 3]) expect(isSingleComponentName(bad)).toBe(false);
  });
});

describe('checkScope', () => {
  it('writes no audit entry (allowed or refused)', () => {
    const dir = agentHome('zz-echo');
    expect(SafeFsExecutor.checkScope(dir, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } }).allowed).toBe(true);
    expect(SafeFsExecutor.checkScope(dir, { ...RF, nukeAgentHomeScope: { agentName: 'zz-other' } }).allowed).toBe(false);
    expect(SafeFsExecutor.checkScope(path.join(dir, '.instar', 'x'), RF).allowed).toBe(true);
    expect(fs.existsSync(auditDir)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('agrees with the delete on every case', () => {
    const cases: Array<[string, Parameters<typeof SafeFsExecutor.safeRmSync>[1]]> = [];
    const a = agentHome('zz-a');
    const b = agentHome('zz-b');
    cases.push([a, { ...RF, nukeAgentHomeScope: { agentName: 'zz-a' } }]); // allowed
    cases.push([b, { ...RF, nukeAgentHomeScope: { agentName: 'zz-a' } }]); // another agent's home
    cases.push([path.join(a, 'sub'), { ...RF, nukeAgentHomeScope: { agentName: 'zz-a' } }]); // nested
    cases.push([b, { recursive: true, operation: 't', nukeAgentHomeScope: { agentName: 'zz-b' } }]); // no force
    for (const [target, opts] of cases) {
      fs.mkdirSync(target, { recursive: true });
      const decision = SafeFsExecutor.checkScope(target, opts);
      expect(rmAllowed(target, opts)).toBe(decision.allowed);
    }
  });
});

describe('nukeAgentHomeScope allowance', () => {
  it('allows exactly the guard-built path with recursive and force', () => {
    const dir = agentHome('zz-echo');
    const d = SafeFsExecutor.checkScope(dir, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } });
    expect(d).toMatchObject({ allowed: true, reason: 'nuke-agent-home-scope' });
    expect(SafeFsExecutor.checkScope(dir, { recursive: true, operation: 't', nukeAgentHomeScope: { agentName: 'zz-echo' } }).allowed).toBe(false);
    expect(SafeFsExecutor.checkScope(dir, { force: true, operation: 't', nukeAgentHomeScope: { agentName: 'zz-echo' } }).allowed).toBe(false);
    SafeFsExecutor.safeRmSync(dir, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses another agent's home, a nested path, and a symlinked home", () => {
    const echo = agentHome('zz-echo');
    const other = agentHome('zz-echo-wt-1');
    const nested = path.join(echo, 'sub');
    fs.mkdirSync(nested);
    expect(rmAllowed(other, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } })).toBe(false);
    expect(rmAllowed(nested, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } })).toBe(false);
    const real = agentHome('zz-real', path.join(home, 'elsewhere'));
    fs.symlinkSync(real, path.join(home, '.instar', 'agents', 'zz-link'));
    expect(rmAllowed(path.join(home, '.instar', 'agents', 'zz-link'), { ...RF, nukeAgentHomeScope: { agentName: 'zz-link' } })).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(path.join(real, '.instar', 'config.json'))).toBe(true);
  });

  it('an empty name refuses through safeRmSync and the agents folder survives', () => {
    agentHome('zz-echo');
    const agents = path.join(home, '.instar', 'agents');
    expect(rmAllowed(agents, { ...RF, nukeAgentHomeScope: { agentName: '' } })).toBe(false);
    expect(rmAllowed(agents, { ...RF, nukeAgentHomeScope: { agentName: '.' } })).toBe(false);
    expect(fs.existsSync(path.join(agents, 'zz-echo'))).toBe(true);
  });

  it('refuses when ~/.instar is a symlink to a differently named folder (no interior /.instar/)', () => {
    const state = path.join(home, 'zz-state');
    agentHome('zz-echo', path.join(state, 'agents'));
    fs.symlinkSync(state, path.join(home, '.instar'));
    const target = path.join(home, '.instar', 'agents', 'zz-echo');
    const d = SafeFsExecutor.checkScope(target, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } });
    expect(d.allowed).toBe(false);
    expect(rmAllowed(target, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } })).toBe(false);
    expect(fs.existsSync(path.join(state, 'agents', 'zz-echo'))).toBe(true);
  });

  it('an agent-mode home that is a checkout is allowed as today, and through the allowance first', () => {
    const dir = agentHome('zz-echo');
    makeCheckout(dir);
    // Today: the runtime-state carve-out (interior /.instar/) allows it.
    expect(SafeFsExecutor.checkScope(dir, RF)).toMatchObject({ allowed: true, reason: 'agent-runtime-state-carveout' });
    // With the allowance, the exclusive decision is taken first, so it keeps working once the
    // carve-out is narrowed by spec guard-runtime-state-scope.
    expect(SafeFsExecutor.checkScope(dir, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } }))
      .toMatchObject({ allowed: true, reason: 'nuke-agent-home-scope' });
    SafeFsExecutor.safeRmSync(dir, { ...RF, nukeAgentHomeScope: { agentName: 'zz-echo' } });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('without the allowance, an instar checkout outside .instar is still refused (unchanged)', () => {
    const dir = path.join(home, 'zz-checkout');
    fs.mkdirSync(dir);
    makeCheckout(dir);
    expect(SafeFsExecutor.checkScope(dir, RF).allowed).toBe(false);
    expect(rmAllowed(dir, RF)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
