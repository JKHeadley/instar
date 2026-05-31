/**
 * Git-backed signal sources for the AgentWorktreeReaper. Kept separate from the
 * classifier so the reaper stays unit-testable with fakes; the merged-detection
 * is itself a standalone, fake-git-testable function.
 *
 * All queries are read-only (SafeGitExecutor.readSync). The single destructive
 * op — `git worktree remove` — goes through SafeGitExecutor.execSync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import type { AgentWorktreeReaperDeps, WorktreeInfo } from './AgentWorktreeReaper.js';

/** Read-only git executor signature (injected so this module is testable). */
export type ReadGit = (args: string[], cwd: string) => string;

const defaultReadGit: ReadGit = (args, cwd) =>
  SafeGitExecutor.readSync(args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    operation: 'src/monitoring/agentWorktreeGit.ts',
    // The agent home IS a checkout of the instar source tree, so every read the
    // reaper makes (worktree list, status, cherry, rev-parse) trips the
    // SourceTreeGuard without these. readSync still rejects any destructive shape,
    // so the flags only widen the SOURCE-TREE bypass for genuine reads.
    sourceTreeReadOk: true,
    sourceTreeWorktreeManagerOk: true,
  });

/**
 * Resolve the canonical default branch ref that exists locally, preferring the
 * upstream remote. Returns null when none resolve (→ callers treat merged as
 * unknown and KEEP).
 */
export function resolveBaseRef(readGit: ReadGit, repo: string): string | null {
  for (const ref of ['JKHeadley/main', 'upstream/main', 'origin/main', 'main']) {
    try {
      readGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], repo);
      return ref;
    } catch { /* try next */ }
    try {
      readGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], repo);
      return ref;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * True when EVERY commit unique to `branchSha` already has an equivalent patch
 * in `baseRef` — i.e. the branch's content is in the default branch. Uses
 * `git cherry` (patch-id equivalence), which catches fast-forward, merge-commit,
 * rebased, and single-commit-squash merges. A multi-commit squash-merge is NOT
 * detected (its commits' individual patch-ids differ from the squashed commit) →
 * reported NOT merged → KEPT. Conservative by design: it never false-positives
 * "merged", so the reaper never deletes unmerged work.
 */
export function isBranchMerged(readGit: ReadGit, repo: string, baseRef: string, branchSha: string): boolean {
  let out: string;
  try {
    out = readGit(['-C', repo, 'cherry', baseRef, branchSha], repo);
  } catch {
    return false; // cannot determine → treat as unmerged (KEEP)
  }
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true; // no commits ahead of base ⇒ merged
  return lines.every((l) => l.startsWith('-'));
}

/**
 * Build the production git/fs-backed deps for the AgentWorktreeReaper.
 * `worktreesDir` bounds which `git worktree list` entries are considered (the
 * agent's `.worktrees/`); the main checkout and any out-of-tree worktrees are
 * excluded.
 */
export function makeAgentWorktreeReaperDeps(opts: {
  instarRepo: string;
  worktreesDir: string;
  readGit?: ReadGit;
  /** Override the process-cwd scanner (testing). Returns the set of worktree
   *  ROOT paths that currently have a live process cwd inside them. */
  cwdRoots?: () => Set<string>;
  now?: () => number;
}): AgentWorktreeReaperDeps {
  const readGit = opts.readGit ?? defaultReadGit;
  const repo = opts.instarRepo;
  const worktreesReal = (() => { try { return fs.realpathSync(opts.worktreesDir); } catch { return opts.worktreesDir; } })();
  const within = (p: string): boolean => {
    const real = (() => { try { return fs.realpathSync(p); } catch { return p; } })();
    return real === worktreesReal || real.startsWith(worktreesReal + path.sep);
  };

  // Process-cwd scan, memoized for a short TTL so a single reap pass runs `lsof`
  // ONCE, not once per worktree. Maps every process cwd under `.worktrees/` to
  // its worktree root (the immediate child dir). lsof failure ⇒ empty set (fall
  // back to lock files; the reaper still ships dark + dry-run + reviewed).
  const defaultCwdRoots = (): Set<string> => {
    const roots = new Set<string>();
    let out: string;
    try {
      out = execFileSync('lsof', ['-w', '-d', 'cwd', '-Fn'], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
    } catch { return roots; } // @silent-fallback-ok — no cwd signal ⇒ rely on locks
    for (const line of out.split('\n')) {
      if (line.charCodeAt(0) !== 110 /* 'n' */) continue;
      const p = line.slice(1);
      if (!p.startsWith(worktreesReal + path.sep)) continue;
      const rest = p.slice(worktreesReal.length + 1);
      const slug = rest.split(path.sep)[0];
      if (slug) roots.add(path.join(worktreesReal, slug));
    }
    return roots;
  };
  const cwdRootsFn = opts.cwdRoots ?? defaultCwdRoots;
  let cwdCache: Set<string> | null = null;
  let cwdCacheAt = 0;
  const cwdRootsCached = (): Set<string> => {
    const t = Date.now();
    if (!cwdCache || t - cwdCacheAt > 10_000) { cwdCache = cwdRootsFn(); cwdCacheAt = t; }
    return cwdCache;
  };

  return {
    listWorktrees: (): WorktreeInfo[] => {
      let porcelain: string;
      try { porcelain = readGit(['-C', repo, 'worktree', 'list', '--porcelain'], repo); }
      catch { return []; }
      const out: WorktreeInfo[] = [];
      let cur: Partial<WorktreeInfo> = {};
      for (const line of porcelain.split('\n')) {
        if (line.startsWith('worktree ')) {
          cur = { path: line.slice('worktree '.length).trim() };
        } else if (line.startsWith('HEAD ')) {
          cur.headSha = line.slice('HEAD '.length).trim();
        } else if (line.startsWith('branch ')) {
          cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
        } else if (line.startsWith('detached')) {
          cur.branch = null;
        } else if (line.trim() === '') {
          if (cur.path && within(cur.path)) {
            out.push({ path: cur.path, branch: cur.branch ?? null, headSha: cur.headSha ?? '' });
          }
          cur = {};
        }
      }
      if (cur.path && within(cur.path)) {
        out.push({ path: cur.path, branch: cur.branch ?? null, headSha: cur.headSha ?? '' });
      }
      return out;
    },

    isClean: (p: string): boolean => {
      try { return readGit(['-C', p, 'status', '--porcelain'], p).trim() === ''; }
      catch { return false; } // cannot determine cleanliness → treat as dirty (KEEP)
    },

    isMerged: (info: WorktreeInfo): boolean => {
      const base = resolveBaseRef(readGit, repo);
      if (!base || !info.headSha) return false;
      return isBranchMerged(readGit, repo, base, info.headSha);
    },

    isInUse: (p: string): boolean => {
      // A live session lock or a git index lock means in-flight work — KEEP.
      for (const lock of ['.session.lock', path.join('.git', 'index.lock')]) {
        try { if (fs.existsSync(path.join(p, lock))) return true; } catch { /* ignore */ }
      }
      // A running process whose cwd is inside the worktree — KEEP.
      try {
        const real = fs.realpathSync(p);
        if (cwdRootsCached().has(real)) return true;
      } catch { /* ignore */ }
      return false;
    },

    removeWorktree: (p: string): void => {
      // Deliberately NOT --force: the non-forced form refuses to remove a worktree
      // with uncommitted changes or a lock, so it can never destroy in-flight work.
      // The SourceTreeGuard mirrors this — it allows `worktree remove` against the
      // source tree only without --force (see isAllowedWorktreeManagerSubcommand).
      SafeGitExecutor.execSync(['-C', repo, 'worktree', 'remove', p], {
        timeout: 60_000,
        operation: 'src/monitoring/agentWorktreeGit.ts:removeWorktree',
        sourceTreeWorktreeManagerOk: true,
      });
    },

    now: opts.now,
  };
}
