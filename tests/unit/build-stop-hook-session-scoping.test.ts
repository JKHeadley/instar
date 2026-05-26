/**
 * BUILD-STOP-HOOK-SESSION-SCOPING-SPEC — regression + behavior tests.
 *
 * Bug: the /build Stop hook had no notion of WHICH session owns the build.
 * build-state.json carried no owner field, so a build started by session A
 * fired its "keep working" block into every concurrent session — trapping
 * unrelated session B AND draining the owning build's reinforcement budget
 * (every misfire increments reinforcementsUsed; at max the hook stops
 * protecting the real owner too).
 *
 * Fix: build-state.py stamps the owner (tmux session name + Claude session
 * UUID) at init; the hook blocks ONLY the proven owner and approve-exits every
 * other session WITHOUT incrementing the counter. Un-stamped builds get a
 * conservative no-adopt (approve, never claim ownership) — never trap, never
 * invert, never drain.
 *
 * These tests exercise the REAL shipping artifacts end-to-end: the hook body
 * comes from PostUpdateMigrator.getHookContent('build-stop-hook') (the exact
 * string deployed to agents) and the state comes from the real build-state.py.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const BUILD_STATE = path.resolve(__dirname, '../../playbook-scripts/build-state.py');

interface HookResult { decision: string; counter: number; ownerSession: string | null; }

describe('build-stop-hook session-scoping', () => {
  let tmpDir: string;
  let hookPath: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-scope-'));
    fs.mkdirSync(path.join(tmpDir, '.instar', 'state', 'build'), { recursive: true });
    stateFile = path.join(tmpDir, '.instar', 'state', 'build', 'build-state.json');

    // Write the EXACT shipping hook (inline twin = what deployed agents run).
    const migrator = new PostUpdateMigrator({
      projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'),
      port: 4042, hasTelegram: false, projectName: 'test',
    });
    const hooksDir = path.join(tmpDir, '.instar', 'hooks', 'instar');
    fs.mkdirSync(hooksDir, { recursive: true });
    hookPath = path.join(hooksDir, 'build-stop-hook.sh');
    fs.writeFileSync(hookPath, migrator.getHookContent('build-stop-hook'), { mode: 0o755 });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'build-stop-hook-session-scoping.test.ts' });
  });

  /** Create a fresh build in `executing` phase, owned by the given identity. */
  function startBuild(ownerTmux: string, ownerSession: string): void {
    const env = { ...process.env, INSTAR_HOOK_TMUX_SESSION: ownerTmux };
    const argv = `init "scope test" --size SMALL --owner-session "${ownerSession}" --owner-tmux "${ownerTmux}"`;
    execSync(`python3 "${BUILD_STATE}" ${argv}`, { cwd: tmpDir, env, encoding: 'utf8' });
    execSync(`python3 "${BUILD_STATE}" transition planning`, { cwd: tmpDir, encoding: 'utf8' });
    execSync(`python3 "${BUILD_STATE}" transition executing`, { cwd: tmpDir, encoding: 'utf8' });
  }

  function readState(): any { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }

  /**
   * Fire the hook as a given session. `myTmux === null` simulates no resolvable
   * tmux (INSTAR_HOOK_NO_TMUX=1); otherwise the seam pins the tmux name.
   */
  function fireHook(opts: { sessionId?: string; myTmux: string | null }): HookResult {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.myTmux === null) { env.INSTAR_HOOK_NO_TMUX = '1'; delete env.INSTAR_HOOK_TMUX_SESSION; }
    else { env.INSTAR_HOOK_TMUX_SESSION = opts.myTmux; delete env.INSTAR_HOOK_NO_TMUX; }
    const stdin = JSON.stringify(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {});
    const out = execSync(`bash "${hookPath}"`, { cwd: tmpDir, env, input: stdin, encoding: 'utf8' });
    const parsed = JSON.parse(out.trim());
    const state = readState();
    return {
      decision: parsed.decision,
      counter: state.reinforcementsUsed,
      ownerSession: (state.owner || {}).session ?? null,
    };
  }

  it('OWNER (tmux match) is blocked and the counter advances', () => {
    startBuild('echo-A', 'uuid-A');
    const r = fireHook({ sessionId: 'uuid-A', myTmux: 'echo-A' });
    expect(r.decision).toBe('block');
    expect(r.counter).toBe(1);
  });

  it('NON-OWNER (different tmux) approves WITHOUT draining the counter — the core regression', () => {
    startBuild('echo-A', 'uuid-A');
    const r = fireHook({ sessionId: 'uuid-B', myTmux: 'echo-B' });
    expect(r.decision).toBe('approve');
    expect(r.counter).toBe(0); // owner's budget untouched
  });

  it('a non-owner firing repeatedly never drains the owner budget, owner stays protected', () => {
    startBuild('echo-A', 'uuid-A');
    for (let i = 0; i < 5; i++) {
      const r = fireHook({ sessionId: 'uuid-B', myTmux: 'echo-B' });
      expect(r.decision).toBe('approve');
    }
    expect(readState().reinforcementsUsed).toBe(0);
    // Owner can still be protected up to its full budget (SMALL = 3).
    expect(fireHook({ sessionId: 'uuid-A', myTmux: 'echo-A' }).decision).toBe('block');
    expect(fireHook({ sessionId: 'uuid-A', myTmux: 'echo-A' }).decision).toBe('block');
    expect(fireHook({ sessionId: 'uuid-A', myTmux: 'echo-A' }).decision).toBe('block');
    // Budget now exhausted (3/3) → owner is allowed to exit.
    expect(fireHook({ sessionId: 'uuid-A', myTmux: 'echo-A' }).decision).toBe('approve');
  });

  it('owner identified by SESSION UUID alone (owner tmux empty) is blocked', () => {
    startBuild('', 'uuid-A');
    const r = fireHook({ sessionId: 'uuid-A', myTmux: 'echo-anything' });
    expect(r.decision).toBe('block');
    expect(r.counter).toBe(1);
  });

  it('identity-unknown (no tmux, no session) fails open — approve', () => {
    startBuild('echo-A', 'uuid-A');
    const r = fireHook({ myTmux: null });
    expect(r.decision).toBe('approve');
    expect(r.counter).toBe(0);
  });

  it('legacy / un-stamped build: conservative no-adopt — approve, counter unchanged, owner NOT written', () => {
    // Simulate a build created before this fix: strip the owner block.
    startBuild('echo-A', 'uuid-A');
    const s = readState(); delete s.owner; fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
    const r = fireHook({ sessionId: 'whoever', myTmux: 'echo-Z' });
    expect(r.decision).toBe('approve');
    expect(r.counter).toBe(0);
    expect('owner' in readState()).toBe(false); // never bootstrap-adopts
  });

  it('owner tmux match with a ROTATED session UUID: blocked, and owner.session reconciled', () => {
    startBuild('echo-A', 'uuid-OLD');
    const r = fireHook({ sessionId: 'uuid-NEW', myTmux: 'echo-A' });
    expect(r.decision).toBe('block');
    expect(r.ownerSession).toBe('uuid-NEW');
  });

  it('a non-owner with a mismatched session can NEVER clobber owner.session', () => {
    startBuild('echo-A', 'uuid-A');
    fireHook({ sessionId: 'uuid-INTRUDER', myTmux: 'echo-B' });
    expect(readState().owner.session).toBe('uuid-A'); // unchanged
  });

  it('terminal phase still approves regardless of owner (early exit preserved)', () => {
    startBuild('echo-A', 'uuid-A');
    execSync(`python3 "${BUILD_STATE}" transition complete`, { cwd: tmpDir, encoding: 'utf8' });
    const r = fireHook({ sessionId: 'uuid-B', myTmux: 'echo-B' });
    expect(r.decision).toBe('approve');
  });
});

describe('build-state.py owner stamp', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-owner-'));
    fs.mkdirSync(path.join(tmpDir, '.instar', 'state', 'build'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'build-stop-hook-session-scoping.test.ts' });
  });

  function init(env: NodeJS.ProcessEnv, extra = ''): any {
    execSync(`python3 "${BUILD_STATE}" init "owner test" --size SMALL ${extra}`,
      { cwd: tmpDir, env: { ...process.env, ...env }, encoding: 'utf8' });
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.instar', 'state', 'build', 'build-state.json'), 'utf8'));
  }

  it('stamps owner.tmux (from seam) and owner.session (from --owner-session)', () => {
    const s = init({ INSTAR_HOOK_TMUX_SESSION: 'echo-builder' }, '--owner-session "sess-123"');
    expect(s.owner.tmux).toBe('echo-builder');
    expect(s.owner.session).toBe('sess-123');
    expect(typeof s.owner.stampedAt).toBe('string');
  });

  it('leaves owner fields empty (does not crash) when tmux unavailable and no session passed', () => {
    const s = init({ INSTAR_HOOK_NO_TMUX: '1' });
    expect(s.owner.tmux).toBe('');
    expect(s.owner.session).toBe('');
  });

  it('--owner-tmux overrides auto-resolution', () => {
    const s = init({ INSTAR_HOOK_TMUX_SESSION: 'from-seam' }, '--owner-tmux "explicit-tmux"');
    expect(s.owner.tmux).toBe('explicit-tmux');
  });
});
