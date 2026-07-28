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
import { withSyncOp } from '../core/InFlightSyncOpMarker.js';
import { classifyPorcelain } from '../core/worktreeDirtyCheck.js';
import type { AgentWorktreeReaperDeps, WorktreeInfo } from './AgentWorktreeReaper.js';

/**
 * Reaper-specific residue denylist (spec: worktree-reaper-untracked-blindspot).
 * INTENTIONALLY NARROWER than worktreeDirtyCheck's DEFAULT_RESIDUE_DENYLIST: this
 * list gates an irreversible `git worktree remove`, so it contains ONLY paths that
 * are unambiguously never user work. It deliberately EXCLUDES the broad
 * `out/` / `build/` / `coverage/` / `*.log` entries of the shared default — users
 * legitimately hand-author files under those (a `build/deploy.md`, an `analysis.log`),
 * and an untracked one of those on a merged worktree must NEVER be silently reaped.
 * We do NOT mutate DEFAULT_RESIDUE_DENYLIST (it feeds the separate yield-safety
 * config list + other consumers); the reaper carries its own list.
 */
export const REAPER_RESIDUE_DENYLIST: readonly string[] = [
  'dist/', 'node_modules/', '.cache/', '.turbo/', '*.tsbuildinfo',
  '.metadata_never_index',          // instar-managed Spotlight-exclusion marker — never work
  '.instar/instar-dev-traces/',     // instar audit-trace droppings — never work
];

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

/** Run `gh` and return stdout, or null on ANY failure (gh missing, not authed,
 *  not a GitHub repo, timeout). Null is the conservative signal → caller keeps. */
export type RunGh = (args: string[], cwd: string) => string | null;

const defaultRunGh: RunGh = (args, cwd) => {
  try {
    // Funnel through withSyncOp so the in-flight marker sees this blocking spawn
    // (event-loop-resilience spec): the reaper runs in-process on a timer, and a
    // bounded gh call must not read as a "stuck" event loop to the watchdogs.
    return withSyncOp(() => execFileSync('gh', args, { cwd, encoding: 'utf-8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return null; // @silent-fallback-ok — gh unavailable ⇒ no PR signal ⇒ KEEP (conservative)
  }
};

/**
 * Fetch a map of `headRefName → headRefOid` for MERGED PRs, to detect
 * MULTI-COMMIT squash-merges that `git cherry` (patch-id) cannot — the
 * disk-accumulation root cause: a multi-commit branch squash-merged into one
 * commit on main has different commit SHAs/patch-ids, so cherry reports it
 * UNMERGED and the worktree is kept forever. A merged PR is the authoritative
 * "the content is in main" signal; pairing it with an EXACT head-OID match (in
 * the caller) ensures a branch with commits ADDED AFTER the merge is still kept.
 *
 * ONE `gh` call per sweep (bounded `--limit`); fail-safe to an EMPTY map on any
 * error so the reaper degrades to exactly today's cherry-only behavior (KEEP).
 */
export function fetchMergedPrHeadOids(repo: string, opts?: { runGh?: RunGh; limit?: number }): Map<string, string> {
  const runGh = opts?.runGh ?? defaultRunGh;
  const limit = opts?.limit ?? 500;
  const map = new Map<string, string>();
  const out = runGh(['pr', 'list', '--state', 'merged', '--json', 'headRefName,headRefOid', '--limit', String(limit)], repo);
  if (!out) return map; // conservative: no signal
  let arr: unknown;
  try { arr = JSON.parse(out); } catch { return map; }
  if (!Array.isArray(arr)) return map;
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const name = (row as { headRefName?: unknown }).headRefName;
    const oid = (row as { headRefOid?: unknown }).headRefOid;
    if (typeof name === 'string' && typeof oid === 'string' && name && oid) {
      // Latest merged PR for a (reused) branch name wins — gh returns newest first.
      if (!map.has(name)) map.set(name, oid);
    }
  }
  return map;
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
  /** When true (default), `isMerged` falls back to GitHub merged-PR state to
   *  detect multi-commit squash-merges that `git cherry` cannot. Fail-safe:
   *  any gh error degrades to cherry-only (KEEP). Set false to disable the
   *  network call entirely (the legacy cherry-only behavior). */
  githubMergeCheck?: boolean;
  /** Override the merged-PR map source (testing). Returns headRefName→headRefOid. */
  mergedPrMap?: () => Map<string, string>;
  now?: () => number;
}): AgentWorktreeReaperDeps {
  const readGit = opts.readGit ?? defaultReadGit;
  const repo = opts.instarRepo;
  const githubMergeCheck = opts.githubMergeCheck ?? true;
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
    // lint-allow-blocking-scan: AgentWorktreeReaper ships dark + dry-run + reviewed
    // (off by default), so this full-cwd `lsof` is not on any live agent's hot path;
    // bounded by a 15s timeout. Async conversion is tracked as a post-mortem
    // follow-up (docs/postmortems/2026-06-07-server-temporarily-down.md, root cause #4).
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

  // Merged-PR map (headRefName→headRefOid), cached for a short TTL so a single
  // reap pass makes ONE `gh` call, not one per worktree. The map only fixes the
  // multi-commit-squash blind spot in `git cherry`; it is consulted lazily (only
  // when cherry says unmerged) so a fully cherry-detectable repo never calls gh.
  const mergedPrMapFn = opts.mergedPrMap ?? (() => fetchMergedPrHeadOids(repo));
  let prMapCache: Map<string, string> | null = null;
  let prMapCacheAt = 0;
  const mergedPrMapCached = (): Map<string, string> => {
    const t = Date.now();
    if (!prMapCache || t - prMapCacheAt > 60_000) { prMapCache = mergedPrMapFn(); prMapCacheAt = t; }
    return prMapCache;
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
      // Residue-aware via the PURE classifyPorcelain (NOT the fail-OPEN
      // makeWorktreeDirtyCheck wrapper): a worktree whose only entries are
      // reaper-residue (build artifacts / instar markers) is clean; ANY
      // non-residue change — tracked OR a hand-authored untracked file — is dirty.
      // FAIL-CLOSED on any error: cannot determine cleanliness → treat as dirty
      // (KEEP). This is the deletion-safe direction (spec
      // worktree-reaper-untracked-blindspot, convergence BLOCKER): a transient
      // `git status` failure must never make a worktree look reapable.
      try { return !classifyPorcelain(readGit(['-C', p, 'status', '--porcelain'], p), REAPER_RESIDUE_DENYLIST); }
      catch { return false; }
    },

    isMerged: (info: WorktreeInfo): boolean => {
      const base = resolveBaseRef(readGit, repo);
      if (!base || !info.headSha) return false;
      // 1) Patch-id equivalence (fast, offline): fast-forward / merge / rebase /
      //    single-commit-squash. Never false-positives "merged".
      if (isBranchMerged(readGit, repo, base, info.headSha)) return true;
      // 2) Multi-commit squash-merge: `git cherry` cannot see it (SHAs differ).
      //    Consult GitHub merged-PR state — but require an EXACT head-OID match so
      //    a branch with commits ADDED AFTER the merge is still KEPT (those would
      //    be unmerged work). Fail-safe: an empty/missing map ⇒ KEEP.
      if (githubMergeCheck && info.branch) {
        const oid = mergedPrMapCached().get(info.branch);
        if (oid && oid === info.headSha) return true;
      }
      return false;
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

    currentBranch: (p: string): string | null => {
      // The LIVE checked-out branch, read at RECLAIM time to close the enumerate→reclaim
      // TOCTOU. Format matches listWorktrees' info.branch (short name, no refs/heads/).
      // FAIL-CLOSED: any error → null, which cannot equal a real info.branch, so the
      // reclaimRaceGuard KEEPS (never reap on an unreadable live branch).
      try {
        const b = (readGit(['-C', p, 'rev-parse', '--abbrev-ref', 'HEAD'], p) ?? '').trim();
        return b && b !== 'HEAD' ? b : null; // 'HEAD' = detached → null
      } catch {
        // @silent-fallback-ok: fail-closed — an unreadable live branch returns null,
        // which can never equal a real info.branch, so the reclaim guard KEEPS (never
        // reaps on an uncertain branch). The delete-safe direction, not a swallowed bug.
        return null;
      }
    },

    hasActiveBuildMarker: (p: string): boolean => {
      // Belt-and-suspenders: an in-flight builder's explicit "don't reap me" claim.
      // FAIL-CLOSED: an error reading the marker is treated as PRESENT (KEEP), the
      // deletion-safe direction.
      try { return fs.existsSync(path.join(p, '.instar-build-active')); }
      catch {
        // @silent-fallback-ok: fail-closed — an fs error reading the marker is treated
        // as PRESENT (KEEP), the delete-safe direction. Not a swallowed bug.
        return true;
      }
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
