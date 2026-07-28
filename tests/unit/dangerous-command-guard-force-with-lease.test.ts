// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * Wiring + behavior: the `dangerous-command-guard.sh` hook allows the SAFE
 * `git push --force-with-lease` to a NON-protected branch (the legitimate way
 * to update one's OWN amended/rebased PR branch), while still blocking:
 *   - plain `--force` / `-f` (no lease) — always risky,
 *   - any force-push that explicitly targets a protected branch
 *     (main/master/develop/release*).
 *
 * Friction this closes: a dev session resolving its own PR (rebase/amend) hit
 * the guard on `git push --force-with-lease`, which `--force`-pattern-matched
 * and got blocked — even though force-with-lease to a feature branch is safe.
 *
 * Tests cover BOTH writers (init.ts inline copy AND
 * PostUpdateMigrator.getDangerousCommandGuard()) for the carve-out text, plus
 * behavioral runs of the actually-rendered migrator guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

function renderMigratorGuard(): string {
  const m = new PostUpdateMigrator({
    stateDir: '/tmp/no-state',
    projectDir: '/tmp/no-proj',
    port: 4042,
    sessions: { claudePath: 'claude' },
  } as never);
  return (m as unknown as { getDangerousCommandGuard(): string }).getDangerousCommandGuard();
}

function readInitGuard(): string {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/init.ts'), 'utf-8');
  const open = src.indexOf("'dangerous-command-guard.sh'");
  const start = src.indexOf('`#!/bin/bash', open);
  const end = src.indexOf('`, { mode: 0o755 });', start);
  return src.slice(start + 1, end);
}

describe('dangerous-command-guard.sh: force-with-lease carve-out present in both writers', () => {
  it('PostUpdateMigrator.getDangerousCommandGuard contains the carve-out', () => {
    const guard = renderMigratorGuard();
    expect(guard).toContain('FORCE_WITH_LEASE_OWN_BRANCH');
    expect(guard).toContain('--force-with-lease');
    // still keeps the original risky force-push patterns
    expect(guard).toContain('git push --force');
    expect(guard).toContain('git push -f');
  });

  it('init.ts installHooks inline copy contains the carve-out', () => {
    const guard = readInitGuard();
    expect(guard).toContain('FORCE_WITH_LEASE_OWN_BRANCH');
    expect(guard).toContain('--force-with-lease');
  });
});

// ── Behavioral: run the rendered migrator hook (SAFETY_LEVEL defaults to 1) ──

let tmpDir: string;
let guardPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fwl-guard-'));
  guardPath = path.join(tmpDir, 'guard.sh');
  fs.writeFileSync(guardPath, renderMigratorGuard(), { mode: 0o755 });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* test cleanup */ } // safe-fs-allow
});

function runGuard(command: string): { stderr: string; code: number | null } {
  // No config.json in CLAUDE_PROJECT_DIR → SAFETY_LEVEL defaults to 1 (block),
  // and the coherence-gate curl block is skipped (no config file). So the exit
  // code reflects the risky-pattern / carve-out decision directly.
  const env = { ...process.env, CLAUDE_PROJECT_DIR: tmpDir };
  const res = spawnSync('bash', [guardPath, command], { env, encoding: 'utf-8', timeout: 5000 });
  return { stderr: res.stderr ?? '', code: res.status };
}

describe('dangerous-command-guard.sh: force-with-lease runtime behavior', () => {
  it('ALLOWS git push --force-with-lease with no explicit branch (current PR branch)', () => {
    const r = runGuard('git push --force-with-lease');
    expect(r.code, `expected exit 0 (ALLOWED), got code=${r.code} stderr=${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain('destructive');
  });

  it('ALLOWS git push --force-with-lease to a non-protected feature branch', () => {
    const r = runGuard('git push --force-with-lease origin echo/my-feature');
    expect(r.code, `expected exit 0, got code=${r.code} stderr=${r.stderr}`).toBe(0);
  });

  it('ALLOWS force-with-lease to a branch whose name merely CONTAINS a protected word', () => {
    // "feature/main-menu" — "main" is not a standalone branch token, must not match.
    const r = runGuard('git push --force-with-lease origin feature/main-menu');
    expect(r.code, `expected exit 0, got code=${r.code} stderr=${r.stderr}`).toBe(0);
  });

  it('ALLOWS force-with-lease to a feature branch when trailing command text mentions a protected word', () => {
    // Regression for the 2026-06-07 false-positive (topic 19437): the carve-out scanned
    // the WHOLE command input, so a chained status/log message mentioning "release
    // cadence" or "main" elsewhere flipped the protected-branch check and blocked a
    // legitimate PR-branch force-with-lease update. Only the `git push …` invocation is
    // scanned now — the push targets a feature branch, so it MUST be allowed.
    const r = runGuard(
      'git push --force-with-lease origin echo/provider-swap && echo "advancing the release cadence on main"',
    );
    expect(r.code, `expected exit 0 (ALLOWED), got code=${r.code} stderr=${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain('destructive');
  });

  it('BLOCKS plain git push --force (no lease)', () => {
    const r = runGuard('git push --force origin echo/my-feature');
    expect(r.code, '--force without lease must stay blocked').toBe(2);
    expect(r.stderr).toContain('destructive');
  });

  it('BLOCKS git push -f (short force, no lease)', () => {
    const r = runGuard('git push -f origin echo/my-feature');
    expect(r.code).toBe(2);
  });

  it('BLOCKS force-with-lease that explicitly targets main', () => {
    const r = runGuard('git push --force-with-lease origin main');
    expect(r.code, 'force-with-lease to main (protected) must stay blocked').toBe(2);
  });

  it('BLOCKS force-with-lease that explicitly targets master', () => {
    const r = runGuard('git push --force-with-lease master');
    expect(r.code).toBe(2);
  });

  it('still BLOCKS an unrelated risky command (git reset --hard)', () => {
    const r = runGuard('git reset --hard origin/main');
    expect(r.code).toBe(2);
  });
});
