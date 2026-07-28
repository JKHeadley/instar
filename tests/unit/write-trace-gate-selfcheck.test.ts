/**
 * `write-trace.mjs` must refuse to write a trace when the commit gate is not installed.
 *
 * WHY. A worktree created with `git worktree add` inherits `core.hooksPath` from the shared
 * repo config — typically `.husky/_` — while that directory does not exist until `npm ci`
 * plus `npx husky` have run. In that state `git commit` executes NO hook: it prints nothing
 * and succeeds. **A working gate and an uninstalled gate are indistinguishable on screen,
 * because both are silent.** On 2026-07-27 a whole change was committed on the belief the
 * gate had passed it, when the gate had never run.
 *
 * The gate cannot report its own absence — an uninstalled hook cannot execute to announce
 * that it is uninstalled. So the check lives at the nearest chokepoint the agent invokes by
 * hand: writing the trace, which is the step that ASSERTS the change came through the skill.
 *
 * These tests drive the real script as a subprocess against real temporary git repos,
 * rather than reimplementing its logic — a test that reproduces the check it is verifying
 * cannot fail when the check changes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'skills/instar-dev/scripts/write-trace.mjs');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true, force: true,
        operation: 'tests/unit/write-trace-gate-selfcheck.test.ts:cleanup',
      });
    } catch { /* test cleanup only */ }
  }
});

/**
 * A minimal repo laid out the way write-trace.mjs expects, with the script copied to the
 * path it resolves ROOT from (three levels up from skills/instar-dev/scripts/).
 */
function makeRepo(opts: { installGate: boolean }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-trace-gate-'));
  tmpDirs.push(root);

  const op = 'tests/unit/write-trace-gate-selfcheck.test.ts';
  SafeGitExecutor.execSync(['init', '-q'], { cwd: root, stdio: 'ignore', operation: `${op}:git-init` });
  SafeGitExecutor.execSync(['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore', operation: `${op}:git-config-email` });
  SafeGitExecutor.execSync(['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore', operation: `${op}:git-config-name` });

  fs.mkdirSync(path.join(root, 'skills/instar-dev/scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'skills/instar-dev/scripts/write-trace.mjs'));

  fs.mkdirSync(path.join(root, 'upgrades/side-effects'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/specs'), { recursive: true });
  // The script requires a non-stub artifact (>=200 chars), so this must be real text.
  const body = 'Side-effects review body used purely to satisfy the artifact length floor. '.repeat(6);
  fs.writeFileSync(path.join(root, 'upgrades/side-effects/demo.md'), body);
  fs.writeFileSync(path.join(root, 'docs/specs/demo.eli16.md'), body);

  // The failure condition: hooksPath points somewhere that does not exist. This is the
  // DEFAULT state of a fresh worktree, not an exotic misconfiguration.
  SafeGitExecutor.execSync(['config', 'core.hooksPath', '.husky/_'], { cwd: root, stdio: 'ignore', operation: `${op}:git-config-hookspath` });
  if (opts.installGate) {
    fs.mkdirSync(path.join(root, '.husky/_'), { recursive: true });
    fs.writeFileSync(path.join(root, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
  }
  return root;
}

function runTrace(root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [
    'skills/instar-dev/scripts/write-trace.mjs',
    '--tier', '1',
    '--tier-reasoning', 'test',
    '--artifact', 'upgrades/side-effects/demo.md',
    '--eli16-path', 'docs/specs/demo.eli16.md',
    '--side-effects-path', 'upgrades/side-effects/demo.md',
    '--files', 'src/demo.ts',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('write-trace gate-installation self-check', () => {
  it('THE FIX: refuses to write a trace when hooksPath points at a missing directory', () => {
    const root = makeRepo({ installGate: false });
    const res = runTrace(root);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('the commit gate is NOT installed');
    expect(res.stderr).toContain('core.hooksPath');

    // The refusal must be total: no trace file may exist afterwards.
    const dir = path.join(root, '.instar/instar-dev-traces');
    const written = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(written, 'no trace may be written when the gate is absent').toEqual([]);
  });

  it('writes normally when the gate IS installed — the check does not block real work', () => {
    // Dead-check for the test above: without this, an always-refusing script would pass it.
    const root = makeRepo({ installGate: true });
    const res = runTrace(root);

    expect(res.status).toBe(0);
    const dir = path.join(root, '.instar/instar-dev-traces');
    expect(fs.readdirSync(dir).length).toBe(1);

    const trace = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
    // A normal trace must NOT carry the override markers, so an overridden trace is
    // distinguishable from an approved one by presence rather than by value.
    expect(trace.gateInstallationOverridden).toBeUndefined();
    expect(trace.gateInstallationReason).toBeUndefined();
  });

  it('the override proceeds but RECORDS itself in the trace', () => {
    const root = makeRepo({ installGate: false });
    const res = runTrace(root, { INSTAR_DEV_ALLOW_UNINSTALLED_GATE: '1' });

    expect(res.status).toBe(0);
    const dir = path.join(root, '.instar/instar-dev-traces');
    const trace = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));

    // The point of recording it: a trace written without a live gate can never later be
    // mistaken for one the gate approved.
    expect(trace.gateInstallationOverridden).toBe(true);
    expect(trace.gateInstallationReason).toContain('core.hooksPath');
  });

  it('accepts a classic .git/hooks/pre-commit install (hooksPath unset)', () => {
    // Not every repo uses husky. Refusing those would be an over-block.
    const root = makeRepo({ installGate: false });
    const op = 'tests/unit/write-trace-gate-selfcheck.test.ts';
    SafeGitExecutor.execSync(['config', '--unset', 'core.hooksPath'], { cwd: root, stdio: 'ignore', operation: `${op}:git-unset-hookspath` });
    const gitDir = SafeGitExecutor.readSync(['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8', operation: `${op}:git-dir` }).trim();
    const hooks = path.resolve(root, gitDir, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n');

    const res = runTrace(root);
    expect(res.status).toBe(0);
  });

  /**
   * Scope boundary. The hazard is "a git repo whose commit hook will not run"; where there
   * is no repo there is no commit, so the check does not apply. Existing harnesses
   * (write-trace-tier, duplicate-build-guard-gates) drive this script inside a bare temp
   * directory and must keep working WITHOUT each of them remembering an env var — pushing
   * that burden onto the next test author is the willpower trade this change removes.
   */
  it('does NOT apply outside a git repository — bare directories still write a trace', () => {
    const root = makeRepo({ installGate: false });
    SafeFsExecutor.safeRmSync(path.join(root, '.git'), {
      recursive: true, force: true,
      operation: 'tests/unit/write-trace-gate-selfcheck.test.ts:degit',
    });

    const res = runTrace(root);
    expect(res.status, res.stderr).toBe(0);

    const dir = path.join(root, '.instar/instar-dev-traces');
    const trace = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
    // Not-applicable is not an override: nothing was bypassed, so nothing is recorded.
    expect(trace.gateInstallationOverridden).toBeUndefined();
  });

  it('refuses when hooksPath is unset AND no classic hook exists', () => {
    const root = makeRepo({ installGate: false });
    const op = 'tests/unit/write-trace-gate-selfcheck.test.ts';
    SafeGitExecutor.execSync(['config', '--unset', 'core.hooksPath'], { cwd: root, stdio: 'ignore', operation: `${op}:git-unset-hookspath2` });
    const gitDir = SafeGitExecutor.readSync(['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8', operation: `${op}:git-dir2` }).trim();
    const preCommit = path.resolve(root, gitDir, 'hooks', 'pre-commit');
    if (fs.existsSync(preCommit)) {
      SafeFsExecutor.safeRmSync(preCommit, { force: true, operation: `${op}:rm-pre-commit` });
    }

    const res = runTrace(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unset');
  });
});
