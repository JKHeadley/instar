// safe-git-allow: test-fixture-git — tests spin up a throwaway tmp git repo (git init + git add + git commit + tmpdir cleanup) to drive the e2e-pairing script under controlled state.
/**
 * Tests for the E2E-pairing gate script.
 *
 * The script reads the staged git diff and blocks commits that change
 * src/server/*.ts without a paired tests/e2e/*.test.ts. We test it by
 * setting up a tmp git repo, staging known combinations, and invoking
 * the script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/check-e2e-pairing.cjs');

const childEnv: NodeJS.ProcessEnv = { ...process.env };
delete childEnv.GIT_DIR;
delete childEnv.GIT_WORK_TREE;
delete childEnv.GIT_INDEX_FILE;
delete childEnv.GIT_OBJECT_DIRECTORY;
delete childEnv.GIT_COMMON_DIR;
delete childEnv.INSTAR_SKIP_E2E_PAIRING;

function runCheck(cwd: string, extraEnv: Record<string, string> = {}): { exitCode: number; stderr: string } {
  try {
    execFileSync('node', [SCRIPT_PATH], { cwd, encoding: 'utf-8', stdio: 'pipe', env: { ...childEnv, ...extraEnv } });
    return { exitCode: 0, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stderr: Buffer | string };
    return { exitCode: e.status, stderr: String(e.stderr ?? '') };
  }
}

function stage(cwd: string, filepath: string, content: string): void {
  const full = path.join(cwd, filepath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  execFileSync('git', ['add', filepath], { cwd, stdio: 'pipe', env: childEnv });
}

describe('check-e2e-pairing.cjs', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pairing-gate-'));
    execFileSync('git', ['init', '-q'], { cwd: repo, env: childEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, env: childEnv });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, env: childEnv });
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT_PATH, path.join(repo, 'scripts', 'check-e2e-pairing.cjs'));
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo, env: childEnv });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('passes when no server files are staged', () => {
    stage(repo, 'src/core/foo.ts', 'export const x = 1;');
    expect(runCheck(repo).exitCode).toBe(0);
  });

  it('blocks when a server file is staged without an e2e test', () => {
    stage(repo, 'src/server/newRoutes.ts', 'export function createNewRoutes() { return {}; }');
    const r = runCheck(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('E2E-PAIRING GATE');
    expect(r.stderr).toContain('newRoutes.ts');
  });

  it('passes when a server file is staged WITH an e2e test', () => {
    stage(repo, 'src/server/newRoutes.ts', 'export function createNewRoutes() { return {}; }');
    stage(repo, 'tests/e2e/new-routes-lifecycle.test.ts', 'import { it } from "vitest"; it("alive", () => {});');
    expect(runCheck(repo).exitCode).toBe(0);
  });

  it('ignores server test files (only non-test server source triggers)', () => {
    stage(repo, 'src/server/foo.test.ts', 'import { it } from "vitest"; it("x", () => {});');
    expect(runCheck(repo).exitCode).toBe(0);
  });

  it('ignores .d.ts declaration files', () => {
    stage(repo, 'src/server/types.d.ts', 'export interface X { a: number; }');
    expect(runCheck(repo).exitCode).toBe(0);
  });

  it('respects the INSTAR_SKIP_E2E_PAIRING bypass', () => {
    stage(repo, 'src/server/newRoutes.ts', 'export function createNewRoutes() { return {}; }');
    expect(runCheck(repo, { INSTAR_SKIP_E2E_PAIRING: '1' }).exitCode).toBe(0);
  });

  it('respects the EXEMPT marker in a staged server file', () => {
    stage(repo, 'src/server/refactor.ts', '// E2E-PAIRING: EXEMPT — pure rename, behavior unchanged\nexport const y = 2;');
    expect(runCheck(repo).exitCode).toBe(0);
  });

  it('blocks server change even when an unrelated non-e2e test is staged', () => {
    stage(repo, 'src/server/newRoutes.ts', 'export function createNewRoutes() { return {}; }');
    stage(repo, 'tests/unit/something.test.ts', 'import { it } from "vitest"; it("x", () => {});');
    expect(runCheck(repo).exitCode).toBe(1);
  });
});
