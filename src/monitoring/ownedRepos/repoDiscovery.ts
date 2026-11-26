/**
 * Finding repositories (docs/specs/no-data-loss-on-machine-death.md §1.3, discovery path 3).
 *
 * Never walks the whole home folder. At a repository root it asks git for the directories
 * git itself does not track — untracked ones and ignored ones, two queries — because git
 * folds such a directory into one entry (Echo's home answers `apps/`, not
 * `apps/instar-ios/`). Each returned directory gets a BOUNDED descent that stops at any
 * `.git` (a directory, or a worktree's `.git` file), and prunes: paths already known as
 * worktrees, regenerable directories (node_modules, build output, caches), symlinks, and
 * the peer-copy and drill areas (never discovered by any path). Every visited entry counts
 * against the run budget, and the work queue is the durable resume cursor.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitReader } from './repoGit.js';
import { listWorktrees } from './repoInspect.js';

/** Directories that are regenerable (the reaper's own classes): pruned, never descended. */
export const REGENERABLE_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'DerivedData', 'Pods', '.gradle', '.build', '.next', '.nuxt', '.turbo', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', '.pytest_cache', '.mypy_cache', 'target', 'build', 'dist', 'coverage',
]);

export type ScanItem = { kind: 'root' | 'repo' | 'descend'; path: string };

/** Paths no discovery path may ever take (§1.3): peer copies, the drill, temp and scratch roots. */
export function isExcludedPath(p: string, userHome: string): boolean {
  const abs = path.resolve(p);
  const under = (root: string) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const excluded = [
    path.join(userHome, '.instar', 'peer-copies'),
    path.join(userHome, '.instar', 'drill'),
    path.resolve(os.tmpdir()),
    '/tmp', '/private/tmp', '/var/folders', '/private/var/folders',
  ];
  return excluded.some(under);
}

/** A discovery root is allowed only inside the user's home (never the home itself or above), or a declared root. */
export function isAllowedRoot(p: string, userHome: string, declared: readonly string[]): boolean {
  const abs = path.resolve(p);
  if (isExcludedPath(abs, userHome)) return false;
  if (declared.some((d) => path.resolve(d) === abs || abs.startsWith(path.resolve(d) + path.sep))) return true;
  return abs.startsWith(path.resolve(userHome) + path.sep);
}

/** The untracked and ignored directories git reports at a repository root (two queries). */
export async function gitUntrackedDirs(repoRoot: string, git: GitReader): Promise<{ ok: boolean; dirs: string[]; error?: string }> {
  const dirs = new Set<string>();
  for (const extra of [[], ['--ignored', '--exclude-standard']]) {
    const r = await git(repoRoot, ['ls-files', '--others', '--directory', '-z', ...extra], { timeoutMs: 60_000 });
    if (!r.ok) return { ok: false, dirs: [], error: r.error };
    for (const e of r.stdout.split('\0')) if (e.endsWith('/')) dirs.add(path.join(repoRoot, e.slice(0, -1)));
  }
  return { ok: true, dirs: [...dirs] };
}

export interface ScanBudget { deadline: number; maxEntries: number; entries: number }

export interface ScanContext {
  git: GitReader;
  userHome: string;
  /** Worktree and repository paths already known (pruned from descent). */
  known: Set<string>;
  /** Called for each repository working root found. */
  onRepo: (root: string) => void;
  /** Directories that could not be read this pass (reported, never "no repositories"). */
  onUnreadable: (dir: string, why: string) => void;
}

/**
 * Process the work queue in place until it is empty or the budget runs out.
 * Returns true when the queue emptied (the pass completed).
 */
export async function runScan(queue: ScanItem[], budget: ScanBudget, ctx: ScanContext): Promise<boolean> {
  while (queue.length) {
    if (Date.now() > budget.deadline || budget.entries >= budget.maxEntries) return false;
    const item = queue.pop()!;
    if (isExcludedPath(item.path, ctx.userHome)) continue;
    if (item.kind === 'root') {
      if (hasGitEntry(item.path)) { found(item.path, queue, ctx); } else queue.push({ kind: 'descend', path: item.path });
      continue;
    }
    if (item.kind === 'repo') {
      const common = await ctx.git(item.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (common.ok) for (const w of await listWorktrees(item.path, common.stdout.trim())) ctx.known.add(path.resolve(w));
      const u = await gitUntrackedDirs(item.path, ctx.git);
      if (!u.ok) { ctx.onUnreadable(item.path, u.error ?? 'git could not list its untracked folders'); continue; }
      for (const d of u.dirs) if (!pruned(d, ctx)) queue.push({ kind: 'descend', path: d });
      continue;
    }
    // descend
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(item.path, { withFileTypes: true }); }
    catch (e) { ctx.onUnreadable(item.path, e instanceof Error ? e.message : String(e)); continue; }
    budget.entries += entries.length;
    if (entries.some((e) => e.name === '.git')) { found(item.path, queue, ctx); continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue; // symlinks are never followed
      const child = path.join(item.path, e.name);
      if (!pruned(child, ctx)) queue.push({ kind: 'descend', path: child });
    }
  }
  return true;
}

function hasGitEntry(dir: string): boolean {
  try { fs.lstatSync(path.join(dir, '.git')); return true; } catch { return false; } // @silent-fallback-ok — no .git means not a repository root
}

function pruned(dir: string, ctx: ScanContext): boolean {
  const abs = path.resolve(dir);
  return REGENERABLE_DIR_NAMES.has(path.basename(abs)) || ctx.known.has(abs) || isExcludedPath(abs, ctx.userHome);
}

function found(root: string, queue: ScanItem[], ctx: ScanContext): void {
  const abs = path.resolve(root);
  if (ctx.known.has(abs)) return; // a known worktree or repository: its record already covers it
  ctx.known.add(abs);
  ctx.onRepo(abs);
  queue.push({ kind: 'repo', path: abs });
}

/** The repository root that encloses `p` (walking up, never above the allowed roots), or null. */
export function enclosingRepoRoot(p: string, userHome: string, declared: readonly string[]): string | null {
  let cur = path.resolve(p);
  try { if (!fs.statSync(cur).isDirectory()) cur = path.dirname(cur); } catch { cur = path.dirname(cur); } // @silent-fallback-ok — a path that does not exist yet starts from its parent
  for (let i = 0; i < 64; i++) {
    if (!isAllowedRoot(cur, userHome, declared)) return null;
    if (hasGitEntry(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}
