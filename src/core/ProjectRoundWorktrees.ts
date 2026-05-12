/**
 * ProjectRoundWorktrees — lazy worktree allocator for project rounds.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.5 step 3.
 *
 * Each round-item gets its own git worktree at
 *   <targetRepoPath>/.worktrees/<projectId>/<roundIndex>/<itemId>
 *
 * On first allocation in a target repo, `.worktrees/` is appended to
 * `.git/info/exclude` so the worktree namespace doesn't pollute
 * `git status` or get caught by `git add -A`. The exclude file is
 * per-clone (not committed), matching the spec.
 *
 * `prune()` runs `git worktree prune` against the round's namespace.
 * Idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SafeGitExecutor } from './SafeGitExecutor.js';

export interface AllocateInput {
  targetRepoPath: string;
  projectId: string;
  roundIndex: number;
  itemId: string;
}

export interface AllocateResult {
  /** Absolute path to the new worktree (or existing one if `refuseExisting:false`). */
  worktreePath: string;
  /** True when the worktree was created in this call; false when it pre-existed. */
  created: boolean;
}

export class ProjectRoundWorktrees {
  /** Compute the worktree path WITHOUT creating it. */
  static pathFor(input: AllocateInput): string {
    return path.join(
      input.targetRepoPath,
      '.worktrees',
      input.projectId,
      String(input.roundIndex),
      input.itemId
    );
  }

  /**
   * Lazy-allocate a worktree for one item. Idempotent on first creation,
   * but refuses by default if the directory pre-exists (matches spec
   * "Refuse if the path already exists").
   */
  static allocate(input: AllocateInput, opts: { refuseExisting?: boolean } = {}): AllocateResult {
    this.ensureExcludeEntry(input.targetRepoPath);
    const wt = this.pathFor(input);
    if (fs.existsSync(wt)) {
      if (opts.refuseExisting !== false) {
        throw new Error(`Worktree path already exists: ${wt}`);
      }
      return { worktreePath: wt, created: false };
    }
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    SafeGitExecutor.run(
      ['worktree', 'add', '--detach', wt],
      { cwd: input.targetRepoPath, operation: 'ProjectRoundWorktrees.allocate' }
    );
    return { worktreePath: wt, created: true };
  }

  /**
   * Prune the round's worktree namespace. Runs `git worktree prune`
   * on the target repo (cheap; idempotent).
   */
  static prune(targetRepoPath: string): void {
    SafeGitExecutor.run(
      ['worktree', 'prune'],
      { cwd: targetRepoPath, operation: 'ProjectRoundWorktrees.prune' }
    );
  }

  /**
   * Forcibly remove a single allocated worktree (e.g., on round halt
   * cleanup). Uses `git worktree remove --force` so dirty checkouts
   * don't block cleanup. Idempotent: missing worktrees pass through.
   */
  static remove(input: AllocateInput): void {
    const wt = this.pathFor(input);
    if (!fs.existsSync(wt)) return;
    try {
      SafeGitExecutor.run(
        ['worktree', 'remove', '--force', wt],
        { cwd: input.targetRepoPath, operation: 'ProjectRoundWorktrees.remove' }
      );
    } catch {
      // Worktree may not be registered with git (created out-of-band).
      // Fall through; prune() will clean it up.
    }
  }

  /**
   * Append `.worktrees/` to `.git/info/exclude` if not present.
   * Idempotent. Per-clone (not committed).
   */
  static ensureExcludeEntry(targetRepoPath: string): void {
    const excludePath = path.join(targetRepoPath, '.git', 'info', 'exclude');
    // Worktree-mode repos have `.git` as a file, not a dir — skip in that case.
    if (!fs.existsSync(excludePath)) {
      // `.git/info/` may not exist on a fresh repo; create it.
      const infoDir = path.join(targetRepoPath, '.git', 'info');
      if (!fs.existsSync(infoDir)) {
        try { fs.mkdirSync(infoDir, { recursive: true }); } catch { return; }
      }
      try { fs.writeFileSync(excludePath, ''); } catch { return; }
    }
    let body: string;
    try {
      body = fs.readFileSync(excludePath, 'utf-8');
    } catch {
      return;
    }
    const lines = body.split('\n').map((l) => l.trim());
    if (lines.includes('.worktrees/')) return;
    const newBody = body.endsWith('\n') ? body + '.worktrees/\n' : body + '\n.worktrees/\n';
    try {
      fs.writeFileSync(excludePath, newBody);
    } catch {
      // Read-only filesystems or permission issues — defense-in-depth.
    }
  }
}
