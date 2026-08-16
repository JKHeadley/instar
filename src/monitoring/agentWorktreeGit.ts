/**
 * Git-backed signal sources for the AgentWorktreeReaper. Kept separate from the
 * classifier so the reaper stays unit-testable with fakes; the merged-detection
 * is itself a standalone, fake-git-testable function.
 *
 * Read queries go through SafeGitExecutor.readStream (non-blocking; same
 * classification, source-tree guard, env scrubbing and audit funnel as readSync).
 * The single destructive op — `git worktree remove` — goes through
 * SafeGitExecutor.execSync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { classifyPorcelain } from '../core/worktreeDirtyCheck.js';
import type { AgentWorktreeReaperDeps, WorktreeInfo, Awaitable } from './AgentWorktreeReaper.js';

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

/** Shared SafeGitExecutor options for every read this module makes. */
const READ_OPTS = {
  timeout: 30_000,
  operation: 'src/monitoring/agentWorktreeGit.ts',
  // The agent home IS a checkout of the instar source tree, so every read the
  // reaper makes (worktree list, status, cherry, rev-parse) trips the
  // SourceTreeGuard without these. The executor still rejects any destructive
  // shape, so the flags only widen the SOURCE-TREE bypass for genuine reads.
  sourceTreeReadOk: true,
  sourceTreeWorktreeManagerOk: true,
} as const;

/** Output bound for a single git read, matching SafeGitExecutor.readSync's maxBuffer
 *  default. Exceeding it REJECTS (never truncates) — a truncated read would be
 *  indistinguishable from a clean/merged one to the callers that authorise deletes. */
const MAX_READ_BYTES = 10 * 1024 * 1024;

/**
 * Does `file` exist, answered FAIL-CLOSED?
 *
 * WHY NOT `fs.existsSync`. Round-two review found that the lock gates and the
 * build-marker gate wrapped `existsSync` in a `try/catch` whose catch is
 * UNREACHABLE: `existsSync` swallows every error internally and returns `false`.
 * So an EACCES or EIO on a lock file — a file that exists but cannot be read —
 * was reported as ABSENT, i.e. "no in-flight work here", which CLEARS a delete
 * gate. The fail-closed comment above those catches was describing a branch that
 * could never run.
 *
 * `statSync` throws instead, which lets the distinction be made: ENOENT is a
 * genuine absence, anything else means "cannot tell" and is answered PRESENT —
 * the KEEP direction for every caller of this helper.
 */
function existsFailClosed(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch (err) {
    // @silent-fallback-ok: this IS the fail-closed decision, not a swallowed error.
    // A STRUCTURAL absence answers false; an ambiguous error (permissions, IO,
    // symlink loop) answers PRESENT so the caller KEEPs rather than deletes on a
    // file it could not read.
    //
    // ENOTDIR is a structural absence and MUST be listed. In a worktree `.git` is a
    // FILE (a gitdir pointer), not a directory, so `stat(<wt>/.git/index.lock)`
    // fails ENOTDIR — the lock cannot exist at that path. Treating that as "cannot
    // tell" made every worktree read as in-use and the reaper reap NOTHING, which
    // the end-to-end test caught immediately. Recorded because it is the same
    // shape as the defect being fixed, one step in the opposite direction:
    // fail-closed applied too widely becomes an inert guard.
    const code = (err as NodeJS.ErrnoException)?.code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

const defaultReadGit: ReadGit = (args, cwd) =>
  SafeGitExecutor.readSync(args, { cwd, encoding: 'utf-8', ...READ_OPTS });

/**
 * Non-blocking read-only git executor signature.
 *
 * WHY THIS EXISTS. The blocking `ReadGit` above is `execFileSync`, and the
 * worktree-reaper READ ROUTE fans it out once per worktree. Measured on a live
 * agent (2026-07-29, 48 worktrees): one request to `GET /worktrees/agent-reaper`
 * froze the Node event loop for 10.6 seconds — every route, every timer, the
 * lease heartbeat and the mesh probes stalled for that window, because a
 * synchronous spawn cannot be preempted.
 */
export type AsyncReadGit = (args: string[], cwd: string) => Promise<string>;

/**
 * Production non-blocking read — `SafeGitExecutor.readAsync`, the funnel's async
 * twin of `readSync`.
 *
 * WHY IT IS NOT `readStream` PLUS LOCAL ACCUMULATION (which is what this was).
 * `readStream` applies the same classification, guard and env scrubbing, but it
 * returns a live child, so the funnel emits its audit row at SPAWN time and never
 * sees how the read ENDED: a failed read that gates a DELETE was recorded as
 * `allowed` with no failure row, while the blocking path records
 * `denied: subprocess-error`. Round-two review caught the spec claiming audit
 * parity that the code did not have. Accumulation, the output bound and the
 * wall-clock bound now live inside the funnel, so the parity is real.
 *
 * Resolves only on a CLEAN exit (code 0). Partial stdout is discarded on every
 * failure shape — a non-zero exit, a spawn error, an oversized read, a torn-down
 * pipe, or either timeout — so a truncated read can never be mistaken for a
 * successful one. Every caller in this module treats a rejection as "cannot
 * determine", which routes to the KEEP / deletion-safe direction exactly as the
 * blocking version did.
 */
export const defaultReadGitAsync: AsyncReadGit = (args, cwd) =>
  SafeGitExecutor.readAsync(args, {
    cwd, encoding: 'utf-8', maxBuffer: MAX_READ_BYTES, ...READ_OPTS,
  });

/**
 * Non-blocking runner for the two NON-git commands on this read path (`lsof`,
 * `gh`). Same contract as `defaultReadGitAsync`: resolves only on a clean exit,
 * discards partial output on any failure, and every caller treats a rejection as
 * "no signal" (which routes to the conservative direction).
 *
 * These were the LAST two blocking spawns on the read path. Leaving them
 * synchronous would have meant the hazard was only REDUCED, not removed: `lsof`
 * over every process on a busy machine costs seconds, and `gh pr list` is a
 * network round trip. Both are memoized (10s / 60s), so they cost one call per
 * request rather than one per worktree — but a cold cache still froze the loop,
 * and the event-loop test deliberately excludes both for determinism, so the test
 * could not have caught it. Converting them is what makes "the read path does not
 * block the loop" true rather than nearly true.
 */
const execFileAsync = promisify(execFile);

/**
 * Grace added to a child's own timeout before {@link withDeadline} fires. The
 * child-level timeout is the PREFERRED exit; this margin keeps the fallback from
 * racing it, so it only fires when the child mechanism failed to settle at all.
 * Matches SafeGitExecutor.readAsync's WALL_CLOCK_GRACE_MS.
 */
const WALL_CLOCK_GRACE_MS = 5_000;

/**
 * Wall-clock ceiling on a single-flight memo entry. Sized above the slowest
 * bounded call any of them makes (`gh pr list` at 30s + grace) so it never
 * pre-empts a legitimately slow-but-progressing read; it exists only to
 * guarantee the in-flight marker clears when the callee never settles at all.
 */
const MEMO_DEADLINE_MS = 60_000;

/**
 * Reject `p` if it has not settled within `ms`.
 *
 * WHY EVERY AWAIT ON THIS PATH NEEDS ONE. A subprocess timeout kills the child,
 * but `close` fires only once every stdio pipe is closed — a helper process
 * holding stdout keeps the promise pending forever. That is not merely a slow
 * read: the memos below and the reaper's own pass marker clear themselves in
 * `.finally()`, which NEVER RUNS on a promise that never settles. Round-two
 * review traced the consequence exactly — one wedged read would pin both read
 * routes and the background reaper pass permanently, and the reaper would then
 * look like a healthy guard that simply never finds anything. Unconditional
 * settlement is what makes the single-flight markers self-clearing.
 *
 * The timer is unref'd so it can never itself hold the process open.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded wall-clock bound of ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

async function runNonGitAsync(
  cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; maxBuffer: number },
): Promise<string> {
  const { stdout } = await withDeadline(
    execFileAsync(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer,
      killSignal: 'SIGKILL',
    }),
    opts.timeoutMs + WALL_CLOCK_GRACE_MS,
    cmd,
  );
  return typeof stdout === 'string' ? stdout : String(stdout);
}

/**
 * Run `tasks` with at most `limit` in flight.
 *
 * Making the read path non-blocking is necessary but NOT sufficient: unbounded
 * async fan-out would convert one event-loop freeze into a burst of ~150
 * concurrent git subprocesses on a 48-worktree agent, which is a different
 * resource hazard (cf. the 2026-06-20 fork-bomb incident and the host-wide spawn
 * cap that came out of it). The bound keeps the loop free AND the process count
 * civil. Order of results always matches order of `tasks`.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  // NaN-safe. A non-finite limit (a config typo like "high") used to yield
  // Array.from({length: NaN}) => ZERO workers => Promise.all([]) resolves instantly and
  // `out` stays a sparse array of holes — which downstream reads as "0 reclaimable",
  // a fabricated answer on the surface that gates a deleter.
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const width = Math.max(1, Math.min(requested, items.length));
  let next = 0;
  let aborted = false;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      if (aborted) return;               // stop the fan-out once a sibling has failed
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i] as T, i);
      } catch (err) {
        // Without this, Promise.all rejects while the surviving workers keep consuming
        // the cursor and spawning children for results nobody will read — detached work
        // that outlives the settled promise and races the next request's pass.
        aborted = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

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
    } catch { /* @silent-fallback-ok: probing candidate ref names; a miss is the normal case and the loop ends at `return null`, which callers treat as unresolved (→ KEEP). */ }
    try {
      readGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], repo);
      return ref;
    } catch { /* @silent-fallback-ok: probing candidate ref names; a miss is the normal case and the loop ends at `return null`, which callers treat as unresolved (→ KEEP). */ }
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
    // @silent-fallback-ok: deliberate fail-closed. `false` here means NOT merged,
    // which KEEPS the worktree. A read failure must never resolve toward deletion.
    return false; // cannot determine → treat as unmerged (KEEP)
  }
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true; // no commits ahead of base ⇒ merged
  return lines.every((l) => l.startsWith('-'));
}

/** Run `gh` and return stdout, or null on ANY failure (gh missing, not authed,
 *  not a GitHub repo, timeout). Null is the conservative signal → caller keeps. */
export type RunGh = (args: string[], cwd: string) => Promise<string | null>;

const defaultRunGh: RunGh = async (args, cwd) => {
  try {
    // Non-blocking since the event-loop fix. No withSyncOp wrapper is needed now:
    // that marker existed to stop a BLOCKING spawn reading as a stuck event loop
    // to the watchdogs — an async spawn never stalls the loop, so there is nothing
    // to mask. Removing the mask alongside the cause is deliberate.
    return await runNonGitAsync('gh', args, { cwd, timeoutMs: 30_000, maxBuffer: 16 * 1024 * 1024 });
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
export async function fetchMergedPrHeadOids(
  repo: string, opts?: { runGh?: RunGh; limit?: number },
): Promise<Map<string, string>> {
  const runGh = opts?.runGh ?? defaultRunGh;
  const limit = opts?.limit ?? 500;
  const map = new Map<string, string>();
  const out = await runGh(['pr', 'list', '--state', 'merged', '--json', 'headRefName,headRefOid', '--limit', String(limit)], repo);
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

/** Async twin of resolveBaseRef. Same order, same null-on-none semantics. */
export async function resolveBaseRefAsync(readGit: AsyncReadGit, repo: string): Promise<string | null> {
  for (const ref of ['JKHeadley/main', 'upstream/main', 'origin/main', 'main']) {
    try {
      await readGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], repo);
      return ref;
    } catch { /* @silent-fallback-ok: probing candidate ref names; a miss is the normal case and the loop ends at `return null`, which callers treat as unresolved (→ KEEP). */ }
    try {
      await readGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], repo);
      return ref;
    } catch { /* @silent-fallback-ok: probing candidate ref names; a miss is the normal case and the loop ends at `return null`, which callers treat as unresolved (→ KEEP). */ }
  }
  return null;
}

/** Async twin of isBranchMerged. Conservative identically: unknown ⇒ NOT merged (KEEP). */
export async function isBranchMergedAsync(
  readGit: AsyncReadGit, repo: string, baseRef: string, branchSha: string,
): Promise<boolean> {
  let out: string;
  try {
    out = await readGit(['-C', repo, 'cherry', baseRef, branchSha], repo);
  } catch {
    // @silent-fallback-ok: deliberate fail-closed. `false` here means NOT merged,
    // which KEEPS the worktree. A read failure must never resolve toward deletion.
    return false; // cannot determine → treat as unmerged (KEEP)
  }
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
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
  /** Override the NON-BLOCKING read (testing). Defaults to defaultReadGitAsync. */
  readGitAsync?: AsyncReadGit;
  /** Override the process-cwd scanner (testing). Returns the set of worktree
   *  ROOT paths that currently have a live process cwd inside them. */
  cwdRoots?: () => Awaitable<Set<string> | 'unknown'>;
  /** When true (default), `isMerged` falls back to GitHub merged-PR state to
   *  detect multi-commit squash-merges that `git cherry` cannot. Fail-safe:
   *  any gh error degrades to cherry-only (KEEP). Set false to disable the
   *  network call entirely (the legacy cherry-only behavior). */
  githubMergeCheck?: boolean;
  /** Override the merged-PR map source (testing). Returns headRefName→headRefOid. */
  mergedPrMap?: () => Map<string, string> | Promise<Map<string, string>>;
  now?: () => number;
}): AgentWorktreeReaperDeps & { isInUseTriState: (path: string) => Promise<boolean | 'unknown'> } {
  const readGit = opts.readGit ?? defaultReadGit;
  // Injection contract: a caller that supplies ONLY the blocking `readGit` (every
  // existing unit test does) must still control what the async path reads —
  // otherwise `readGit` silently stops affecting isClean/isMerged/listWorktrees
  // and those tests assert against real git without noticing. Derive rather than
  // ignore. An explicit `readGitAsync` always wins.
  const readGitA: AsyncReadGit = opts.readGitAsync
    ?? (opts.readGit ? async (args, cwd) => opts.readGit!(args, cwd) : defaultReadGitAsync);
  const repo = opts.instarRepo;
  const githubMergeCheck = opts.githubMergeCheck ?? true;
  const worktreesReal = (() => { try { return fs.realpathSync(opts.worktreesDir); } catch { return opts.worktreesDir; } })();
  const within = (p: string): boolean => {
    const real = (() => { try { return fs.realpathSync(p); } catch { return p; } })();
    return real === worktreesReal || real.startsWith(worktreesReal + path.sep);
  };

  // Process-cwd scan, memoized + single-flighted so a pass runs `lsof` ONCE, not
  // once per worktree. Maps every process cwd under `.worktrees/` to its worktree
  // root (the immediate child dir). A FAILED scan returns 'unknown' (NOT an empty
  // set) so isInUse can answer KEEP — an empty set would be a success-shaped
  // rejection that clears a delete gate.
  const defaultCwdRoots = async (): Promise<Set<string> | 'unknown'> => {
    const roots = new Set<string>();
    let out: string;
    // The `lint-allow-blocking-scan` exemption that used to sit here was REMOVED
    // with its justification. It claimed this scan was "not on any live agent's hot
    // path" because the reaper ships off + dry-run — but the reaper is constructed
    // unconditionally and the READ ROUTE runs this pass regardless of those flags,
    // and on the agent where it was measured the reaper was enabled with dryRun
    // off. The claim was false, so the fix is to stop blocking rather than to keep
    // the exemption. (Removes ONE INSTANCE of the hazard class in root cause #4 of
    // docs/postmortems/2026-06-07-server-temporarily-down.md. It does NOT close that
    // root cause: the two follow-ups that postmortem actually names —
    // OrphanProcessReaper and mcpProcessReaper — still use blocking scans and are
    // untouched here. An earlier version claimed the closure outright; the spec
    // retracted that and this comment did not until round five.)
    try {
      out = await runNonGitAsync('lsof', ['-w', '-d', 'cwd', '-Fn'], { timeoutMs: 15_000, maxBuffer: 32 * 1024 * 1024 });
    } catch {
      // @silent-fallback-ok: this is a fail-CLOSED widening, not a degraded result —
      // it returns an explicit 'unknown' rather than a success-shaped empty answer.
      // FAIL-CLOSED. Returning an empty set here (the previous behaviour) is a
      // success-shaped rejection: "the scan failed" became indistinguishable from
      // "no process is using this worktree", which CLEARS a delete gate. Every other
      // signal on this path fails toward KEEP; this one failed toward DELETE. An
      // explicit 'unknown' lets isInUse answer KEEP instead.
      return 'unknown';
    }
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
  const cwdRootsFn: () => Awaitable<Set<string> | 'unknown'> = opts.cwdRoots ?? defaultCwdRoots;
  let cwdCache: Set<string> | 'unknown' | null = null;
  let cwdCacheAt = 0;
  let cwdInFlight: Promise<Set<string> | 'unknown'> | null = null;
  const cwdRootsCached = async (): Promise<Set<string> | 'unknown'> => {
    const t = Date.now();
    if (cwdCache && t - cwdCacheAt <= 10_000) return cwdCache;
    // Single-flight: without this, a bounded fan-out of N evaluations racing a cold
    // cache would each launch its own full-system scan — the async equivalent of the
    // stampede the memo exists to prevent.
    if (!cwdInFlight) {
      // The deadline is what makes the `.finally()` below reachable: `cwdRootsFn` is
      // INJECTABLE, so the bound inside runNonGitAsync does not cover every wiring.
      // Without it, one non-settling implementation pins this marker forever and
      // every later caller joins a promise that never resolves.
      cwdInFlight = withDeadline(
        Promise.resolve(cwdRootsFn()), MEMO_DEADLINE_MS, 'cwd-roots scan',
      )
        .then((r) => { cwdCache = r; cwdCacheAt = Date.now(); return r; })
        .finally(() => { cwdInFlight = null; });
    }
    return cwdInFlight;
  };

  // Merged-PR map (headRefName→headRefOid), cached for a short TTL so a single
  // reap pass makes ONE `gh` call, not one per worktree. The map only fixes the
  // multi-commit-squash blind spot in `git cherry`; it is consulted lazily (only
  // when cherry says unmerged) so a fully cherry-detectable repo never calls gh.
  const mergedPrMapFn = opts.mergedPrMap ?? (() => fetchMergedPrHeadOids(repo));
  let prMapCache: Map<string, string> | null = null;
  let prMapCacheAt = 0;
  let prMapInFlight: Promise<Map<string, string>> | null = null;
  const mergedPrMapCached = async (): Promise<Map<string, string>> => {
    const t = Date.now();
    if (prMapCache && t - prMapCacheAt <= 60_000) return prMapCache;
    // Single-flight, same reason as the cwd scan: one network call per cold window,
    // never one per concurrent evaluation.
    if (!prMapInFlight) {
      // Deadline for the same reason as the cwd memo: `mergedPrMapFn` is injectable,
      // so the marker's self-clearing cannot depend on the callee settling.
      prMapInFlight = withDeadline(
        Promise.resolve(mergedPrMapFn()), MEMO_DEADLINE_MS, 'merged-PR map',
      )
        .then((m) => { prMapCache = m; prMapCacheAt = Date.now(); return m; })
        .finally(() => { prMapInFlight = null; });
    }
    return prMapInFlight;
  };

  // Default-branch ref, memoized. THE DEFECT THIS FIXES: `isMerged` previously
  // called resolveBaseRef() for EVERY worktree, un-memoized — up to 4 candidate
  // names probed 2 ways each, so ~5 extra git spawns per worktree on an agent
  // whose first candidate remote is absent (the fleet shape), on top of the
  // per-worktree status + cherry. Resolved once per pass instead.
  let baseRefCache: { ref: string | null } | null = null;
  let baseRefCacheAt = 0;
  let baseRefInFlight: Promise<string | null> | null = null;
  const baseRefCached = async (): Promise<string | null> => {
    const t = Date.now();
    if (baseRefCache && t - baseRefCacheAt <= 60_000) return baseRefCache.ref;
    // Single-flight, like the cwd and PR-map memos. Without it the bounded fan-out
    // stampedes a cold cache: N workers each see a null cache (it is only assigned
    // AFTER the await) and each runs the full resolution — up to 8 probes apiece on a
    // fleet agent, undoing the entire once-per-pass saving this memo exists for.
    if (!baseRefInFlight) {
      // Deadline: resolveBaseRefAsync awaits an INJECTED readGitA, so a test double or
      // future wiring that never settles must not pin this marker for the process's life.
      baseRefInFlight = withDeadline(
        resolveBaseRefAsync(readGitA, repo), MEMO_DEADLINE_MS, 'base-ref resolution',
      )
        .then((ref) => {
          // Do NOT cache a null: a transient failure would otherwise pin EVERY worktree
          // on the agent to "unmerged" for the full TTL with no signal.
          if (ref !== null) { baseRefCache = { ref }; baseRefCacheAt = Date.now(); }
          return ref;
        })
        .finally(() => { baseRefInFlight = null; });
    }
    return baseRefInFlight;
  };

  return {
    listWorktrees: async (): Promise<WorktreeInfo[]> => {
      let porcelain: string;
      // PROPAGATES rather than returning []. Round five found that swallowing it here
      // made the reaper's `enumerationFailed` flag UNREACHABLE in production: the
      // flag is set when this throws, and this never threw, so a real agent whose
      // `git worktree list` failed rendered `{reclaimable: 0, enumerationFailed:
      // false}` — the fabricated "nothing to reclaim" the flag exists to prevent.
      // The only test covering it injected a throwing dep production never supplied.
      //
      // The old comment's argument ("fewer candidates, never a spurious one") is true
      // of the REAP path and false of the SNAPSHOT path, and it was applied to both.
      // Both callers still fail safe: `reapPass` catches this and reports an empty
      // pass, and `snapshotUncoalesced` catches it and sets the honest flag.
      porcelain = await readGitA(['-C', repo, 'worktree', 'list', '--porcelain'], repo);
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

    isClean: async (p: string): Promise<boolean> => {
      // Residue-aware via the PURE classifyPorcelain (NOT the fail-OPEN
      // makeWorktreeDirtyCheck wrapper): a worktree whose only entries are
      // reaper-residue (build artifacts / instar markers) is clean; ANY
      // non-residue change — tracked OR a hand-authored untracked file — is dirty.
      // FAIL-CLOSED on any error: cannot determine cleanliness → treat as dirty
      // (KEEP). This is the deletion-safe direction (spec
      // worktree-reaper-untracked-blindspot, convergence BLOCKER): a transient
      // `git status` failure must never make a worktree look reapable.
      try { return !classifyPorcelain(await readGitA(['-C', p, 'status', '--porcelain'], p), REAPER_RESIDUE_DENYLIST); }
      catch {
        // @silent-fallback-ok: THIS IS the fail-closed decision described above —
        // `false` from isClean means NOT clean (dirty), which KEEPS the worktree.
        return false;
      }
    },

    isMerged: async (info: WorktreeInfo): Promise<boolean> => {
      const base = await baseRefCached();
      if (!base || !info.headSha) return false;
      // 1) Patch-id equivalence (fast, offline): fast-forward / merge / rebase /
      //    single-commit-squash. Never false-positives "merged".
      if (await isBranchMergedAsync(readGitA, repo, base, info.headSha)) return true;
      // 2) Multi-commit squash-merge: `git cherry` cannot see it (SHAs differ).
      //    Consult GitHub merged-PR state — but require an EXACT head-OID match so
      //    a branch with commits ADDED AFTER the merge is still KEPT (those would
      //    be unmerged work). Fail-safe: an empty/missing map ⇒ KEEP.
      if (githubMergeCheck && info.branch) {
        const oid = (await mergedPrMapCached()).get(info.branch);
        if (oid && oid === info.headSha) return true;
      }
      return false;
    },

    // POLARITY WARNING. `true` here means KEEP for the reaper (safe) but SKIP for the
    // orphaned-work detector (unsafe — it means "do not flag this as abandoned"). A
    // failed scan collapsed to `true` therefore protects a deleter and BLINDS a
    // detector. Consumers whose polarity is opposite MUST use `isInUseTriState` and
    // handle 'unknown' explicitly rather than reading this boolean.
    isInUse: async (p: string): Promise<boolean> => {
      // A live session lock or a git index lock means in-flight work — KEEP.
      for (const lock of ['.session.lock', path.join('.git', 'index.lock')]) {
        if (existsFailClosed(path.join(p, lock))) return true;
      }
      // A running process whose cwd is inside the worktree — KEEP.
      try {
        const roots = await cwdRootsCached();
        // An UNKNOWN scan means we cannot prove the worktree is idle. KEEP — the
        // deletion-safe direction, matching every other signal on this path.
        if (roots === 'unknown') return true;
        const real = fs.realpathSync(p);
        if (roots.has(real)) return true;
      } catch { return true; } // cannot determine ⇒ KEEP
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
      return existsFailClosed(path.join(p, '.instar-build-active'));
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

    /**
     * The UNCOLLAPSED liveness answer: true (in use) / false (idle) / 'unknown'
     * (could not determine). `isInUse` above collapses 'unknown' to true because that
     * is KEEP for a deleter. A consumer whose polarity is reversed — the orphaned-work
     * detector, where true means "skip, owner alive" — must read this instead, so it
     * can report "liveness unknown" rather than asserting a live owner it never saw.
     */
    isInUseTriState: async (p: string): Promise<boolean | 'unknown'> => {
      for (const lock of ['.session.lock', path.join('.git', 'index.lock')]) {
        if (existsFailClosed(path.join(p, lock))) return true;
      }
      try {
        const roots = await cwdRootsCached();
        if (roots === 'unknown') return 'unknown';
        const real = fs.realpathSync(p);
        return roots.has(real);
      } catch { return 'unknown'; }
    },

    now: opts.now,
  };
}
