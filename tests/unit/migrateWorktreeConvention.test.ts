// safe-git-allow: test file — fs.rmSync is for per-test tmpdir cleanup;
//   the migrator under test uses safe-executor patterns where appropriate.

/**
 * Unit tests for PostUpdateMigrator.migrateWorktreeConvention (Layer 3).
 *
 * Spec: docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md §"Layer 3 —
 * PostUpdateMigrator step (single-agent scope)".
 *
 * Covers: idempotency, .bin/ symlink refusal, wrapper always-overwrites,
 * .gitignore idempotent insertion, .worktrees/ 0700 creation,
 * silent-skip for project-bound agents whose home doesn't match the
 * `<instarHome>/agents/<name>/` shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

// The migrator's agent-home validation imports loadRegistry; we control
// what it returns by writing a temporary `~/.instar/registry.json`. To
// keep tests hermetic we redirect HOME for the duration of each test.
let originalHome: string | undefined;
let tmp: string;

function setHome(dir: string): void {
  originalHome = process.env.HOME;
  process.env.HOME = dir;
}

function restoreHome(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}

function setupAgentHome(opts: { name: string; createBinAsSymlink?: boolean }): {
  agentHome: string;
  stateDir: string;
  binDir: string;
} {
  const instarHome = path.join(tmp, '.instar');
  fs.mkdirSync(instarHome, { recursive: true });
  // Write a registry containing our agent.
  fs.writeFileSync(
    path.join(instarHome, 'registry.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          name: opts.name,
          type: 'standalone',
          path: path.join(instarHome, 'agents', opts.name),
          port: 9999,
          pid: 0,
          status: 'stopped',
          createdAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
        },
      ],
    }),
  );
  const agentHome = path.join(instarHome, 'agents', opts.name);
  const stateDir = path.join(agentHome, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const binDir = path.join(agentHome, '.bin');
  if (opts.createBinAsSymlink) {
    const decoy = fs.mkdtempSync(path.join(tmp, 'decoy-bin-'));
    fs.symlinkSync(decoy, binDir);
  }
  return { agentHome, stateDir, binDir };
}

function makeMigrator(stateDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir: path.dirname(stateDir),
    stateDir,
    port: 9999,
    hasTelegram: false,
    projectName: 'integ-agent',
  });
}

describe('PostUpdateMigrator.migrateWorktreeConvention', () => {
  let originalAuditDir: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwm-mig-'));
    setHome(tmp);
    // Redirect SafeGitExecutor's destructive-ops audit log to the per-test
    // tmpdir so the full PostUpdateMigrator.migrate() chain — which fans
    // out into many other steps that may call git via SafeGitExecutor —
    // doesn't write to `<cwd>/.instar/audit/destructive-ops.jsonl` and
    // mutate the CI working tree (the working-tree integrity check in
    // .github/workflows/ci.yml rejects any post-test mutation).
    originalAuditDir = process.env.INSTAR_AUDIT_LOG_DIR;
    process.env.INSTAR_AUDIT_LOG_DIR = path.join(tmp, 'audit');
  });

  afterEach(() => {
    if (originalAuditDir === undefined) delete process.env.INSTAR_AUDIT_LOG_DIR;
    else process.env.INSTAR_AUDIT_LOG_DIR = originalAuditDir;
    restoreHome();
    // The full PostUpdateMigrator runs many other steps that fan out
    // writes (builtin-skills, jobs, etc.); recursive cleanup of tmp can
    // race with those if any are async-fire-and-forget. maxRetries
    // smooths over the ENOTEMPTY race.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Best-effort cleanup — tmpdir gets garbage-collected by the OS.
    }
  });

  it('installs the wrapper, creates .worktrees/ 0700, and patches .gitignore on first run', () => {
    const { agentHome } = setupAgentHome({ name: 'echo-test' });
    const migrator = makeMigrator(path.join(agentHome, '.instar'));
    const result = migrator.migrate();
    expect(result.upgraded.some((s) => s.includes('worktree-convention'))).toBe(true);

    const wrapper = path.join(agentHome, '.bin', 'instar-worktree-create.sh');
    expect(fs.existsSync(wrapper)).toBe(true);
    const wrapperMode = fs.statSync(wrapper).mode & 0o777;
    // 0755 — file must be executable for users to be able to run it.
    expect((wrapperMode & 0o111) !== 0).toBe(true);

    const worktreesDir = path.join(agentHome, '.worktrees');
    expect(fs.existsSync(worktreesDir)).toBe(true);
    expect(fs.statSync(worktreesDir).mode & 0o777).toBe(0o700);

    const gitignore = fs.readFileSync(path.join(agentHome, '.gitignore'), 'utf-8');
    expect(gitignore).toMatch(/^\.worktrees\/$/m);
  });

  it('is idempotent on second run — no error, no duplicate .gitignore entries', () => {
    const { agentHome } = setupAgentHome({ name: 'echo-idem' });
    const migrator = makeMigrator(path.join(agentHome, '.instar'));
    migrator.migrate();
    const result2 = migrator.migrate();
    expect(result2.errors).toEqual([]);
    expect(result2.skipped.some((s) => s.includes('worktree-convention'))).toBe(true);
    const gitignore = fs.readFileSync(path.join(agentHome, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/^\.worktrees\/$/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  it('always overwrites the wrapper (Migration Parity Standard)', () => {
    const { agentHome } = setupAgentHome({ name: 'echo-overwrite' });
    const migrator = makeMigrator(path.join(agentHome, '.instar'));
    migrator.migrate();
    const wrapper = path.join(agentHome, '.bin', 'instar-worktree-create.sh');
    // Tamper with the wrapper, then re-run.
    fs.writeFileSync(wrapper, '# tampered\n');
    const result = migrator.migrate();
    expect(result.upgraded.some((s) => s.includes('instar-worktree-create.sh'))).toBe(true);
    const content = fs.readFileSync(wrapper, 'utf-8');
    expect(content).not.toContain('# tampered');
    expect(content).toContain('instar-worktree-create');
  });

  it('refuses to write when <agent_home>/.bin is a symlink (covers the /usr/local/bin clobber adversarial finding)', () => {
    const { agentHome } = setupAgentHome({ name: 'echo-attacker', createBinAsSymlink: true });
    const migrator = makeMigrator(path.join(agentHome, '.instar'));
    const result = migrator.migrate();
    expect(result.errors.some((e) => e.includes('worktree-convention') && e.includes('symlink'))).toBe(true);
    // Wrapper must NOT have been installed inside the symlinked .bin.
    const symlinkedBin = path.join(agentHome, '.bin');
    const symlinkTarget = fs.readlinkSync(symlinkedBin);
    expect(fs.existsSync(path.join(symlinkTarget, 'instar-worktree-create.sh'))).toBe(false);
  });

  it('silently skips when the agent home is not under <instarHome>/agents/ (project-bound agent)', () => {
    // Create a project-style state dir outside ~/.instar/agents/.
    const projectDir = fs.mkdtempSync(path.join(tmp, 'project-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    // No registry entry for this project.
    fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.instar', 'registry.json'), JSON.stringify({ version: 1, entries: [] }));
    const migrator = makeMigrator(stateDir);
    const result = migrator.migrate();
    expect(result.errors.filter((e) => e.includes('worktree-convention'))).toEqual([]);
    expect(result.skipped.some((s) => s.includes('worktree-convention'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.bin', 'instar-worktree-create.sh'))).toBe(false);
  });
});
