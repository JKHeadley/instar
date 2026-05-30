// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * Wiring: the `dangerous-command-guard.sh` hook refuses `gh pr merge` when
 * any PR check is non-passing. Closes the 2026-05-27 PR #539
 * watch-exit-merge class (`gh run watch` returns 0 on workflow completion
 * regardless of conclusion, so a `watch && gh pr merge` chain merged a
 * branch with red unit-test shards — cost a fix-forward + a fleet outage).
 *
 * Tests cover:
 *   1. Guard content (both `installHooks` inline copy in init.ts AND
 *      `PostUpdateMigrator.getDangerousCommandGuard()`) carries the new
 *      gate block.
 *   2. Behavioral: spawn the actual rendered guard script with a mocked
 *      `gh` binary on PATH; verify the gate blocks when checks are red,
 *      allows when checks are green, allows `--auto`, allows when the
 *      command is something other than `gh pr merge`.
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
  // The dangerous-command-guard content is inlined in src/commands/init.ts.
  // Extract the template-literal body between the writeFileSync open and
  // the closing backtick + `, { mode: 0o755 });`.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/init.ts'), 'utf-8');
  const open = src.indexOf("'dangerous-command-guard.sh'");
  const start = src.indexOf('`#!/bin/bash', open);
  const end = src.indexOf('`, { mode: 0o755 });', start);
  return src.slice(start + 1, end);
}

describe('dangerous-command-guard.sh: gh pr merge gate is present in both writers', () => {
  it('PostUpdateMigrator.getDangerousCommandGuard contains the gh pr merge gate', () => {
    const guard = renderMigratorGuard();
    expect(guard).toMatch(/gh \+pr \+merge/);
    expect(guard).toContain('--auto');
    expect(guard).toContain('watch-exit-merge');
    expect(guard).toContain('gh pr checks');
  });

  it('init.ts installHooks inline copy contains the gh pr merge gate', () => {
    const guard = readInitGuard();
    expect(guard).toMatch(/gh \+pr \+merge/);
    expect(guard).toContain('--auto');
    expect(guard).toContain('watch-exit-merge');
  });
});

// ── Behavioral: run the rendered hook with a mocked gh on PATH ─────────

let tmpDir: string;
let guardPath: string;
let mockGhDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pr-merge-gate-'));
  guardPath = path.join(tmpDir, 'guard.sh');
  fs.writeFileSync(guardPath, renderMigratorGuard(), { mode: 0o755 });
  mockGhDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(mockGhDir);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* test cleanup */ } // safe-fs-allow
});

/**
 * Drop a fake `gh` binary on PATH that emits `out` for any `gh pr checks` call
 * and `viewPr` for any `gh pr view` call.
 */
function installMockGh({ checks, prNum }: { checks: Array<{ name: string; state: string }>; prNum?: number }): void {
  const checksJson = JSON.stringify(checks);
  const viewJson = String(prNum ?? '');
  const ghScript = [
    '#!/bin/bash',
    'case "$1 $2" in',
    '  "pr checks")',
    `    cat <<'JSON'`,
    checksJson,
    `JSON`,
    '    ;;',
    '  "pr view")',
    `    printf '%s' '${viewJson}'`,
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
  ].join('\n');
  fs.writeFileSync(path.join(mockGhDir, 'gh'), ghScript, { mode: 0o755 });
}

function runGuard(command: string): { stdout: string; stderr: string; code: number | null } {
  const env = {
    ...process.env,
    PATH: `${mockGhDir}:${process.env.PATH}`,
    CLAUDE_PROJECT_DIR: tmpDir,
  };
  const res = spawnSync('bash', [guardPath, command], { env, encoding: 'utf-8', timeout: 5000 });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status };
}

describe('dangerous-command-guard.sh: gh pr merge runtime behavior', () => {
  it('BLOCKS when a check is in FAILURE state', () => {
    installMockGh({
      checks: [{ name: 'Unit Tests (node 20, shard 1/4)', state: 'FAILURE' }, { name: 'verify', state: 'SUCCESS' }],
      prNum: 999,
    });
    const r = runGuard('gh pr merge 999 --squash');
    expect(r.code, `expected exit 2 (BLOCKED), got code=${r.code} stderr=${r.stderr}`).toBe(2);
    expect(r.stderr).toContain('non-passing checks');
    expect(r.stderr).toContain('FAILURE');
  });

  it('BLOCKS when a check is still PENDING', () => {
    installMockGh({
      checks: [{ name: 'Unit Tests', state: 'PENDING' }, { name: 'Build', state: 'SUCCESS' }],
      prNum: 999,
    });
    const r = runGuard('gh pr merge 999 --squash');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('PENDING');
  });

  it('ALLOWS when every check is SUCCESS', () => {
    installMockGh({
      checks: [
        { name: 'Unit Tests', state: 'SUCCESS' },
        { name: 'verify', state: 'SUCCESS' },
        { name: 'Build', state: 'SUCCESS' },
      ],
      prNum: 999,
    });
    const r = runGuard('gh pr merge 999 --squash');
    expect(r.code, `expected exit 0 (ALLOWED), got code=${r.code} stderr=${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain('non-passing');
  });

  it('ALLOWS when SKIPPED / SKIPPING checks are present alongside SUCCESS', () => {
    installMockGh({
      checks: [
        { name: 'Unit Tests', state: 'SUCCESS' },
        { name: 'Contract Tests (Live API)', state: 'SKIPPING' },
        { name: 'verify', state: 'SUCCESS' },
      ],
      prNum: 999,
    });
    const r = runGuard('gh pr merge 999 --squash');
    expect(r.code).toBe(0);
  });

  it('ALLOWS gh pr merge --auto (the safe async gate)', () => {
    installMockGh({
      // checks are intentionally red — the gate should NOT consult them
      // when --auto is passed.
      checks: [{ name: 'Unit Tests', state: 'FAILURE' }],
      prNum: 999,
    });
    const r = runGuard('gh pr merge 999 --auto --squash');
    expect(r.code, `expected exit 0 when --auto is passed, got code=${r.code} stderr=${r.stderr}`).toBe(0);
  });

  it('IGNORES commands that are not gh pr merge', () => {
    installMockGh({ checks: [{ name: 'Unit Tests', state: 'FAILURE' }], prNum: 999 });
    const safeCommands = [
      'gh pr view 999',
      'gh pr checks 999',
      'ls -la',
      'echo "gh pr merge in a string literal that should not trigger"',
    ];
    for (const c of safeCommands) {
      const r = runGuard(c);
      expect(r.code, `expected exit 0 for safe command ${JSON.stringify(c)} (got ${r.code} / ${r.stderr})`).toBe(0);
    }
  });

  it('BLOCKS gh pr merge with --admin when checks are red (the #539 incident shape)', () => {
    installMockGh({
      checks: [{ name: 'Unit Tests', state: 'FAILURE' }],
      prNum: 539,
    });
    const r = runGuard('gh pr merge 539 --admin --squash');
    expect(r.code, '--admin must not bypass the gate when checks are red').toBe(2);
  });

  it('BLOCKS when invoked without a PR number, using current-branch PR resolution', () => {
    installMockGh({
      checks: [{ name: 'Unit Tests', state: 'FAILURE' }],
      prNum: 42, // gh pr view returns 42 as current PR
    });
    const r = runGuard('gh pr merge --squash');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('PR #42');
  });
});
