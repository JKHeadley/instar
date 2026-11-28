/**
 * Inspect one git repository, read-only (docs/specs/no-data-loss-on-machine-death.md §1.2).
 *
 * What it answers, for one object store and all its worktrees:
 *  - its remotes (host and account only: a URL's user info or token is never kept), and
 *    whether each one is OFF this machine (a local path or file:// remote is not a copy
 *    anywhere else);
 *  - its single-copy work: commits on local branches that no off-machine remote-tracking
 *    ref reaches, the branches whose tip is one of them, and the oldest such commit;
 *  - the registered worktrees based on Git metadata. Uncommitted work is unmeasured.
 *
 * "Off this machine" in increment 1 means a remote as last fetched: the registry is
 * read-only, so it never fetches. A remote-tracking ref that is stale can only make
 * work look MORE copied than git last saw, never less; increment 2's homing verifies
 * with the receiver's own answer (§1.5).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GitReader } from './repoGit.js';

export interface RepoRemote {
  name: string;
  host: string;
  ownerAccount: string | null;
  /** false for a local path / file:// remote: that copy is on this same disk. */
  offMachine: boolean;
  visibility: 'private' | 'public' | 'unknown';
  collaborators: 'owner-only' | 'shared' | 'unknown';
}

export interface RepoInspection {
  root: string;
  commonDir: string;
  rootCommit: string | null;
  worktrees: string[];
  remotes: RepoRemote[];
  singleCopy: { commits: number; branches: number; oldestAt: number | null; branchNames: string[] };
  uncommitted: { worktrees: number; files: number; bytes: number; oldestAt: number | null; complete: boolean };
  /** 'unknown' when a git read failed: never read as "nothing single-copy". */
  state: 'ok' | 'unknown';
  error?: string;
}

/** Remote URL → host + account, with any credentials dropped. */
export function parseRemoteUrl(url: string): { host: string; ownerAccount: string | null; offMachine: boolean } {
  const u = url.trim();
  if (!u) return { host: 'unknown', ownerAccount: null, offMachine: false };
  if (u.startsWith('file://') || u.startsWith('/') || u.startsWith('./') || u.startsWith('../') || /^[A-Za-z]:[\\/]/.test(u)) {
    return { host: 'this-machine', ownerAccount: null, offMachine: false };
  }
  let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/+([^/]+)?/i.exec(u);
  if (m) {
    const host = m[1].toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return { host: local ? 'this-machine' : host, ownerAccount: m[2] ? m[2].replace(/\.git$/, '') : null, offMachine: !local };
  }
  m = /^(?:[^@]+@)?([^:/]+):\/?([^/]+)?/.exec(u); // scp-like: git@github.com:owner/repo.git
  if (m) return { host: m[1].toLowerCase(), ownerAccount: m[2] ? m[2].replace(/\.git$/, '') : null, offMachine: true };
  return { host: 'unknown', ownerAccount: null, offMachine: false };
}

export function parseRemotes(out: string): RepoRemote[] {
  const seen = new Map<string, RepoRemote>();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (!m || seen.has(m[1])) continue;
    const p = parseRemoteUrl(m[2]);
    seen.set(m[1], { name: m[1].slice(0, 100), host: p.host.slice(0, 200), ownerAccount: p.ownerAccount ? p.ownerAccount.slice(0, 100) : null, offMachine: p.offMachine, visibility: 'unknown', collaborators: 'unknown' });
  }
  return [...seen.values()];
}

/**
 * The repository's worktrees, read from `<common dir>/worktrees/<name>/gitdir` (plain file reads, so no
 * `git worktree` call): the main working root first, then each linked worktree that still exists.
 */
export async function listWorktrees(root: string, commonDir: string): Promise<string[]> {
  const out = [root];
  const dir = path.join(commonDir, 'worktrees');
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir); } catch { return out; } // @silent-fallback-ok — no linked worktrees
  for (const name of names) {
    try {
      const gd = (await fs.promises.readFile(path.join(dir, name, 'gitdir'), 'utf8')).trim();
      const wt = path.dirname(path.resolve(dir, name, gd));
      if (wt !== root && fs.existsSync(wt)) out.push(wt);
    } catch { /* @silent-fallback-ok — a half-removed worktree entry: not a worktree */ }
  }
  return out;
}

/** `%D` decoration (`HEAD -> main, feature-x`) → branch names. */
export function parseDecorations(d: string): string[] {
  return d.split(',').map((x) => x.trim().replace(/^HEAD -> /, '')).filter((x) => x && x !== 'HEAD' && !x.startsWith('tag: '));
}

/** A stable id: sha256 of the root commit + the home-relative path (§1.2). */
export function repoIdFor(rootCommit: string, homeRelativePath: string): string {
  return createHash('sha256').update(`${rootCommit}\u0000${homeRelativePath}`).digest('hex');
}

const BRANCH_NAMES_KEPT = 20;

/** Inspect a repository whose working root is `root`. Never throws. */
export async function inspectRepo(root: string, git: GitReader): Promise<RepoInspection> {
  const out: RepoInspection = {
    root, commonDir: '', rootCommit: null, worktrees: [root], remotes: [],
    singleCopy: { commits: 0, branches: 0, oldestAt: null, branchNames: [] },
    uncommitted: { worktrees: 0, files: 0, bytes: 0, oldestAt: null, complete: false },
    state: 'ok',
  };
  const fail = (e: string) => { out.state = 'unknown'; out.error = e; return out; };

  const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return fail(common.error);
  out.commonDir = common.stdout.trim();

  const remotes = await git(root, ['remote', '-v']);
  if (!remotes.ok) return fail(remotes.error);
  out.remotes = parseRemotes(remotes.stdout);

  const roots = await git(root, ['log', '--max-parents=0', '--all', '--format=%H'], { timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (roots.ok) out.rootCommit = roots.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort()[0] ?? null;

  out.worktrees = await listWorktrees(root, out.commonDir);

  // Single-copy commits: on a local branch, not reached by any off-machine remote's tracking refs.
  const off = out.remotes.filter((r) => r.offMachine).map((r) => `--remotes=${r.name}`);
  const log = await git(root, ['log', '--branches', ...(off.length ? ['--not', ...off] : []), '--format=%H %ct'], { timeoutMs: 120_000, maxBuffer: 128 * 1024 * 1024 });
  if (!log.ok) return fail(log.error);
  const single = new Set<string>();
  let oldest: number | null = null;
  for (const line of log.stdout.split('\n')) {
    const [sha, ct] = line.trim().split(' ');
    if (!sha) continue;
    single.add(sha);
    const t = Number(ct) * 1000;
    if (Number.isFinite(t) && t > 0 && (oldest === null || t < oldest)) oldest = t;
  }
  out.singleCopy.commits = single.size;
  out.singleCopy.oldestAt = oldest;

  // A branch is single-copy when its tip is single-copy (a tip any remote reaches has all its ancestors there too).
  const refs = await git(root, ['log', '--no-walk', '--branches', '--decorate-refs=refs/heads/', '--format=%H %ct %D'], { timeoutMs: 60_000 });
  if (!refs.ok) return fail(refs.error);
  const branches: Array<{ name: string; at: number }> = [];
  for (const line of refs.stdout.split('\n')) {
    const m = /^([0-9a-f]{40,64}) (\d*) ?(.*)$/.exec(line.trim());
    if (m && single.has(m[1])) for (const name of parseDecorations(m[3])) branches.push({ name, at: Number(m[2]) * 1000 || 0 });
  }
  out.singleCopy.branches = branches.length;
  out.singleCopy.branchNames = branches.sort((a, b) => b.at - a.at).slice(0, BRANCH_NAMES_KEPT).map((b) => b.name.slice(0, 200));

  return out;
}
