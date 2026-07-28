/**
 * InstarWorktreeManager — Layer 1 of the Agent Worktree Convention.
 *
 * Creates git worktrees of the shared instar repository inside the agent's
 * own home directory (`~/.instar/agents/<agent>/.worktrees/`). This is the
 * only location the macOS sandbox cannot revoke mid-session.
 *
 * Spec: docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md (status: approved).
 *
 * The CLI subcommand `instar worktree create <branch>` is a thin shim over
 * this manager. All validation, resolution, and audit-trail logic lives
 * here so it can be unit-tested without spawning a CLI process.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry } from './AgentRegistry.js';
import { SafeGitExecutor } from './SafeGitExecutor.js';

// ── Constants ────────────────────────────────────────────────────────────

/** Default allowlist of remote-origin URLs for the canonical instar repo.
 *  Operators can extend via `worktree.repoUrlAllowlist` in `.instar/config.json`. */
export const DEFAULT_INSTAR_REPO_URL_ALLOWLIST: ReadonlyArray<string> = [
  'git@github.com:instar-ai/instar.git',
  'https://github.com/instar-ai/instar.git',
];

const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const AUDIT_DIR_NAME = 'audit';
const AUDIT_LEDGER_BASENAME = 'worktree-ops.jsonl';
const LOCAL_LEDGER_BASENAME = '.ledger.jsonl';

// ── Types ────────────────────────────────────────────────────────────────

export interface ResolveAgentHomeOptions {
  /** Override `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override `process.cwd()`. */
  cwd?: string;
  /** Override the instar home root (defaults to `~/.instar`). */
  instarHome?: string;
  /** Override registry lookup (for tests). Returns the set of registered agent names. */
  registryLookup?: () => Set<string>;
  /** Override registry entries lookup (for tests). Returns name + recorded
   *  home path pairs — the legacy-home acceptance path matches the candidate
   *  against these recorded paths. */
  registryEntriesLookup?: () => ReadonlyArray<{ name: string; path?: string }>;
}

export interface ResolvedAgentHome {
  /** Absolute, real (symlink-resolved) path to the agent home directory. */
  agentHome: string;
  /** Agent name extracted from the trailing path segment. */
  agentName: string;
}

export interface ResolveInstarRepoOptions {
  env?: NodeJS.ProcessEnv;
  /** Override `process.cwd()` for current-checkout discovery. */
  cwd?: string;
  /** Path to user config (defaults to `~/.instar/config.json`). */
  configPath?: string;
  /** Override the URL allowlist entirely (skipping the default + config merge). */
  urlAllowlist?: ReadonlyArray<string>;
  /** Override the fallback chain order (for tests). */
  fallbackChain?: ReadonlyArray<string>;
  /** Override the home directory used for default fallbacks. */
  homeDir?: string;
}

export interface ResolvedInstarRepo {
  /** Absolute, real path to a validated instar repo. */
  repoPath: string;
  /** The allowlisted remote url that validated the repo (url or pushurl). */
  remoteUrl: string;
  /** Name of the remote that won the allowlist check (e.g. 'origin', 'JKHeadley'). */
  remoteName: string;
  /** True when the match was the remote's FETCH url — its refs mirror
   *  canonical instar and are safe as a worktree base. A pushurl-only match
   *  proves trust but NOT ref provenance: on fleet agent homes origin fetches
   *  the personal fork (backup-sync of agent-home files) while pushing to
   *  canonical — its refs must never be used as a code base. */
  remoteFetchesCanonical: boolean;
}

export interface CreateWorktreeOptions {
  /** Branch name to check out / create. */
  branch: string;
  /** Optional override for the worktree directory slug. Defaults to branch with `/` → `-`. */
  slug?: string;
  /** Default true (current bash-helper behavior). Pass false to skip the node_modules symlink. */
  shareNodeModules?: boolean;
  /** Override agent-home resolution (mainly for tests). */
  resolveAgentHomeOpts?: ResolveAgentHomeOptions;
  /** Override instar-repo resolution (mainly for tests). */
  resolveInstarRepoOpts?: ResolveInstarRepoOptions;
  /** Override the base for new branches. If omitted, resolves to origin/HEAD. */
  baseBranch?: string;
  /** Audit-mirror state directory (defaults to `<agent_home>/.instar`). */
  stateDir?: string;
}

export interface CreateWorktreeResult {
  worktreePath: string;
  branch: string;
  slug: string;
  agentHome: string;
  agentName: string;
  instarRepo: string;
  instarRepoSha: string;
  shareNodeModules: boolean;
  /** True if a new branch was created; false if an existing branch was checked out. */
  createdBranch: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Run a git subprocess through SafeGitExecutor. Callers must declare whether
 * the invocation is destructive — that determines which executor path is
 * used (`execSync` for destructive, `readSync` for read-only). Both routes
 * honor the SourceTreeGuard and append to the destructive-ops audit ledger
 * when applicable.
 *
 * SafeGitExecutor's `run` dispatcher classifies by `args[0]` which doesn't
 * skip `-C <dir>` prefixes; we always use `-C` here, so we route explicitly
 * rather than relying on the dispatcher.
 */
function git(args: string[], cwd: string, operation: string, kind: 'read' | 'write'): string {
  const exec = kind === 'write' ? SafeGitExecutor.execSync : SafeGitExecutor.readSync;
  return exec(args, {
    cwd,
    operation,
    stdio: ['ignore', 'pipe', 'pipe'],
    sourceTreeWorktreeManagerOk: true,
  }).trim();
}

function tryGit(
  args: string[],
  cwd: string,
  operation: string,
  kind: 'read' | 'write',
): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    return { ok: true, stdout: git(args, cwd, operation, kind) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const msg = (e.stderr ? String(e.stderr) : e.message ?? 'unknown error').trim();
    return { ok: false, error: msg };
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    // @silent-fallback-ok — sentinel-returning probe; caller decides what to
    //   do with the null (every call site already checks and produces a
    //   clear validation error). Not a degraded continuation.
    return null;
  }
}

function isRealDirectory(p: string): boolean {
  // `lstat` so a symlink to a directory still fails the "real dir" check.
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory();
  } catch {
    // @silent-fallback-ok — sentinel-returning probe; caller validates and
    //   produces a clear error (path-containment refusal).
    return false;
  }
}

// ── Agent home resolution ────────────────────────────────────────────────

export function resolveAgentHome(opts: ResolveAgentHomeOptions = {}): ResolvedAgentHome {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const instarHome = opts.instarHome ?? path.join(os.homedir(), '.instar');
  const agentsRoot = path.join(instarHome, 'agents');
  const agentsRootReal = realpathOrNull(agentsRoot);
  if (!agentsRootReal) {
    throw new Error(
      `agent home: instar agents root not found at ${agentsRoot} — is instar installed for this user?`,
    );
  }

  // Step 1: env var wins.
  let candidate: string | null = null;
  if (env.INSTAR_AGENT_HOME && env.INSTAR_AGENT_HOME.trim()) {
    candidate = env.INSTAR_AGENT_HOME.trim();
  } else {
    // Step 2: walk up from cwd looking for `.instar/AGENT.md`.
    candidate = walkUpForAgentMd(cwd);
    if (!candidate) {
      throw new Error(
        `agent home: INSTAR_AGENT_HOME unset and no .instar/AGENT.md found walking up from ${cwd}`,
      );
    }
  }

  // Resolve symlinks before any structural check — anchors validation in the
  // real filesystem regardless of how the caller worded the path.
  const candidateReal = realpathOrNull(candidate);
  if (!candidateReal) {
    throw new Error(`agent home: candidate ${candidate} does not resolve to a real directory`);
  }

  // Anchored regex: must live exactly one level below the agents root.
  const expectedPrefix = agentsRootReal.endsWith(path.sep)
    ? agentsRootReal
    : `${agentsRootReal}${path.sep}`;
  if (!candidateReal.startsWith(expectedPrefix)) {
    // Legacy-home acceptance: agents onboarded before the worktree convention
    // live outside the agents root (e.g. ~/Documents/Projects/<agent>). The
    // ONLY accepted evidence is the instar registry's own recorded home path —
    // operator-controlled state a planted .instar/AGENT.md cannot forge. The
    // candidate must realpath-equal a registered entry's path AND the entry
    // name must pass the same charset clamp as compliant homes. Worktrees for
    // a legacy home land at <legacyHome>/.worktrees/ — still inside the
    // agent's own granted territory, which is the convention's actual intent.
    const legacy = matchRegisteredLegacyHome(candidateReal, opts);
    if (legacy) return legacy;
    throw new Error(
      `agent home: ${candidateReal} is not under the instar agents root ${agentsRootReal} ` +
      `and does not match any registered agent's recorded home path. If this IS a live ` +
      `legacy agent home, its server must be registered (run it once so it heartbeats into ` +
      `the registry); otherwise set INSTAR_AGENT_HOME to the agent's real home.`,
    );
  }
  const remainder = candidateReal.slice(expectedPrefix.length).replace(/\/+$/, '');
  if (!remainder || remainder.includes('/')) {
    throw new Error(
      `agent home: ${candidateReal} is not a direct child of ${agentsRootReal} (expected exactly one path segment)`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(remainder)) {
    throw new Error(
      `agent home: agent-name segment "${remainder}" violates expected pattern ${AGENT_NAME_PATTERN.source}`,
    );
  }

  // Registry membership.
  const registeredNames = opts.registryLookup
    ? opts.registryLookup()
    : new Set(loadRegistry().entries.map((e) => e.name));
  if (!registeredNames.has(remainder)) {
    throw new Error(
      `agent home: agent "${remainder}" is not present in the instar registry — refuse to operate on an unregistered home`,
    );
  }

  return { agentHome: candidateReal, agentName: remainder };
}

/**
 * Match a candidate directory against the registry's recorded agent-home
 * paths (legacy-home acceptance). Returns the resolved home when exactly the
 * registry vouches for the path; null otherwise (caller produces the refusal).
 *
 * Deliberately narrow: file evidence inside the candidate (.instar/AGENT.md,
 * config.json) counts for NOTHING here — only the registry's own record,
 * realpath-resolved so a symlinked registration still matches.
 */
function matchRegisteredLegacyHome(
  candidateReal: string,
  opts: ResolveAgentHomeOptions,
): ResolvedAgentHome | null {
  // Hermeticity rule: when the caller seamed the registry in ANY form
  // (registryLookup or registryEntriesLookup), never consult the real
  // on-disk registry — a name-only seam means "no entries with paths".
  const entries = opts.registryEntriesLookup
    ? opts.registryEntriesLookup()
    : opts.registryLookup
      ? []
      : loadRegistry().entries.map((e) => ({ name: e.name, path: e.path }));
  for (const entry of entries) {
    if (!entry.path) continue;
    const entryReal = realpathOrNull(entry.path);
    if (!entryReal || entryReal !== candidateReal) continue;
    // Same charset clamp as compliant homes — a registry entry with a hostile
    // name never resolves (falls through to the generic refusal).
    if (!AGENT_NAME_PATTERN.test(entry.name)) continue;
    return { agentHome: candidateReal, agentName: entry.name };
  }
  return null;
}

function walkUpForAgentMd(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, '.instar', 'AGENT.md');
    if (fs.existsSync(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── Instar repo resolution ───────────────────────────────────────────────

export function resolveInstarRepo(opts: ResolveInstarRepoOptions = {}): ResolvedInstarRepo {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? os.homedir();
  const fallbacks = opts.fallbackChain ?? [
    path.join(home, 'Documents', 'Projects', 'instar'),
    path.join(home, 'instar'),
  ];

  const candidates: string[] = [];
  if (env.INSTAR_REPO && env.INSTAR_REPO.trim()) candidates.push(env.INSTAR_REPO.trim());
  candidates.push(cwd);
  if (env.INSTAR_AGENT_HOME && env.INSTAR_AGENT_HOME.trim()) {
    candidates.push(env.INSTAR_AGENT_HOME.trim());
  }
  candidates.push(...fallbacks);

  const allowlist = new Set<string>(opts.urlAllowlist ?? mergedRepoUrlAllowlist(opts.configPath));

  const seen = new Set<string>();
  const failures: string[] = [];
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const result = validateInstarRepoCandidate(candidate, allowlist);
    if (result.ok) {
      return {
        repoPath: result.repoPath,
        remoteUrl: result.remoteUrl,
        remoteName: result.remoteName,
        remoteFetchesCanonical: result.remoteFetchesCanonical,
      };
    }
    failures.push(`  - ${candidate}: ${result.error}`);
  }

  throw new Error(
    `instar repo: no candidate passed integrity validation. Tried:\n${failures.join('\n')}`,
  );
}

function mergedRepoUrlAllowlist(configPath?: string): string[] {
  const merged = new Set<string>(DEFAULT_INSTAR_REPO_URL_ALLOWLIST);
  const resolved = configPath ?? path.join(os.homedir(), '.instar', 'config.json');
  if (fs.existsSync(resolved)) {
    try {
      const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as Record<string, unknown>;
      const wt = raw.worktree as { repoUrlAllowlist?: unknown } | undefined;
      if (wt && Array.isArray(wt.repoUrlAllowlist)) {
        for (const entry of wt.repoUrlAllowlist) {
          if (typeof entry === 'string' && entry.trim()) merged.add(entry.trim());
        }
      }
    } catch {
      // @silent-fallback-ok — config malformed → fall back to bake-in
      //   defaults. The allowlist still enforces (just without operator
      //   additions). Crashing the CLI on user-config syntax errors would
      //   be worse than ignoring the additions for one invocation.
    }
  }
  return [...merged];
}

function validateInstarRepoCandidate(
  candidate: string,
  allowlist: Set<string>,
): {
  ok: true;
  repoPath: string;
  remoteUrl: string;
  remoteName: string;
  remoteFetchesCanonical: boolean;
} | { ok: false; error: string } {
  if (!candidate || !fs.existsSync(candidate)) {
    return { ok: false, error: 'path does not exist' };
  }
  const real = realpathOrNull(candidate);
  if (!real) return { ok: false, error: 'realpath failed' };

  const op = 'src/core/InstarWorktreeManager.ts:resolveInstarRepo';
  const topLevel = tryGit(['-C', real, 'rev-parse', '--show-toplevel'], real, op, 'read');
  if (!topLevel.ok || !topLevel.stdout) {
    return { ok: false, error: `not a git repo (${topLevel.ok ? 'no worktree root' : topLevel.error.split('\n')[0]})` };
  }
  const repoPath = realpathOrNull(topLevel.stdout);
  if (!repoPath) return { ok: false, error: 'repo root realpath failed' };

  // Trust the checkout if ANY of its remote urls is allowlisted, not only origin's.
  // Fleet agents fork instar to a personal remote (origin = instar-<name>.git) while
  // keeping a canonical remote (e.g. JKHeadley → upstream instar) that the worktree
  // actually builds against. An origin-only check rejected every agent's own checkout
  // from `instar worktree create`, defeating the worktree convention for the whole fleet.
  //
  // IMPORTANT: the enumeration must go through `git config --get-regexp`, NOT
  // `git remote -v`. All git here runs through SafeGitExecutor, whose
  // source-tree guard only passes a narrow verb set against the agent's own
  // instar checkout (rev-parse / show-ref / read-only config / ...). `remote`
  // is not in that set, so a `remote -v` call against the agent home — the
  // EXACT layout this any-remote check exists for — threw inside tryGit, was
  // swallowed as {ok:false}, and the whole check silently no-oped: #777
  // shipped dead on arrival, and agents fell back to raw `git worktree add`,
  // which skips identity + husky-hook wiring (the silent local-gate bypass).
  // `config --get-regexp` is in the guard's read-only-config allowance and
  // additionally surfaces `pushurl` (a fork-fetch/canonical-push origin is
  // allowlisted by its push url — `remote -v`'s parser caught that shape only
  // incidentally).
  const remote = tryGit(['-C', repoPath, 'config', '--get', 'remote.origin.url'], repoPath, op, 'read');
  let allowedUrl: string | null =
    remote.ok && remote.stdout && allowlist.has(remote.stdout) ? remote.stdout : null;
  // The NAME of the remote that won the allowlist check, and whether it won
  // via its FETCH url. Both matter downstream: only a fetch-url match means
  // the remote's refs actually mirror canonical instar, making it a safe
  // default base for new worktree branches. On fleet agent homes `origin`
  // fetches the agent's personal fork (whose default branch is a backup-sync
  // of agent-home FILES — no package.json, no src/) while PUSHING to
  // canonical; a pushurl match proves trust, not ref provenance. Branching
  // from origin/HEAD there produced an unusable worktree whose husky wiring
  // silently no-oped (task #82, found by the #829 live re-verify).
  let allowedRemoteName: string | null = allowedUrl ? 'origin' : null;
  let allowedViaFetchUrl = allowedUrl !== null;
  if (!allowedUrl) {
    const allRemotes = tryGit(
      ['-C', repoPath, 'config', '--get-regexp', String.raw`^remote\..*\.(url|pushurl)$`],
      repoPath, op, 'read',
    );
    if (allRemotes.ok && allRemotes.stdout) {
      for (const line of allRemotes.stdout.split('\n')) {
        // git config --get-regexp line: "remote.<name>.url <url>"
        const m = line.match(/^remote\.(\S+)\.(url|pushurl)\s+(\S+)$/);
        if (!m || !allowlist.has(m[3])) continue;
        const isFetchUrl = m[2] === 'url';
        // First match wins UNLESS a later FETCH-url match can upgrade a
        // pushurl-only match — fetch-url remotes are preferred because their
        // refs are canonical (usable as a worktree base).
        if (!allowedUrl || (isFetchUrl && !allowedViaFetchUrl)) {
          allowedRemoteName = m[1];
          allowedUrl = m[3];
          allowedViaFetchUrl = isFetchUrl;
          if (isFetchUrl) break;
        }
      }
    }
  }
  if (!allowedUrl) {
    if (!remote.ok || !remote.stdout) {
      return { ok: false, error: 'remote.origin.url unset' };
    }
    return {
      ok: false,
      error: `remote.origin.url ${remote.stdout} not in worktree.repoUrlAllowlist`,
    };
  }

  // core.hooksPath, if set, must resolve inside the repo.
  const hooksPath = tryGit(['-C', repoPath, 'config', '--get', 'core.hooksPath'], repoPath, op, 'read');
  if (hooksPath.ok && hooksPath.stdout) {
    const resolvedHooks = path.isAbsolute(hooksPath.stdout)
      ? hooksPath.stdout
      : path.resolve(repoPath, hooksPath.stdout);
    const resolvedHooksReal = realpathOrNull(resolvedHooks);
    if (!resolvedHooksReal || !resolvedHooksReal.startsWith(repoPath + path.sep)) {
      return {
        ok: false,
        error: `core.hooksPath ${hooksPath.stdout} resolves outside the repo`,
      };
    }
  }

  return {
    ok: true,
    repoPath,
    remoteUrl: allowedUrl,
    remoteName: allowedRemoteName ?? 'origin',
    remoteFetchesCanonical: allowedViaFetchUrl,
  };
}

// ── Slug / branch validation ─────────────────────────────────────────────

export function defaultSlugFor(branch: string): string {
  return branch.replace(/\//g, '-');
}

export function validateSlug(slug: string, existingSlugsLower: ReadonlySet<string>): void {
  if (!slug || slug === '.' || slug === '..') {
    throw new Error(`slug: refused — empty or relative ("${slug}")`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`slug: refused — must match ${SLUG_PATTERN.source} ("${slug}")`);
  }
  if (slug.startsWith('-')) {
    throw new Error(`slug: refused — leading dash forbidden ("${slug}")`);
  }
  if (existingSlugsLower.has(slug.toLowerCase())) {
    throw new Error(
      `slug: refused — case-insensitive collision with existing worktree directory ("${slug}")`,
    );
  }
}

export function validateBranchName(branch: string, repoPath: string): void {
  if (!branch || branch.includes('\0')) {
    throw new Error(`branch: refused — empty or contains NUL`);
  }
  if (branch.startsWith('-')) {
    // `git check-ref-format` would refuse this too, but our own check is faster
    // and produces a clearer error than passing `--upload-pack=...` to git.
    throw new Error(`branch: refused — leading dash forbidden ("${branch}")`);
  }
  const r = tryGit(['-C', repoPath, 'check-ref-format', '--branch', branch], repoPath, 'src/core/InstarWorktreeManager.ts:validateBranchName', 'read');
  if (!r.ok) {
    throw new Error(`branch: refused by git check-ref-format ("${branch}") — ${r.error.split('\n')[0]}`);
  }
}

// ── Create worktree ──────────────────────────────────────────────────────

export async function createWorktree(opts: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
  const { agentHome, agentName } = resolveAgentHome(opts.resolveAgentHomeOpts);
  const {
    repoPath: instarRepo,
    remoteName: allowlistedRemote,
    remoteFetchesCanonical,
  } = resolveInstarRepo(opts.resolveInstarRepoOpts);

  validateBranchName(opts.branch, instarRepo);

  const worktreesDir = path.join(agentHome, '.worktrees');
  ensureWorktreesDir(worktreesDir);

  const existingSlugsLower = new Set(
    fs.readdirSync(worktreesDir).map((entry) => entry.toLowerCase()),
  );

  const slug = opts.slug?.trim() || defaultSlugFor(opts.branch);
  validateSlug(slug, existingSlugsLower);

  const worktreePath = path.join(worktreesDir, slug);

  // Path containment: realpath the parent (must equal worktreesDir's real path)
  // before any git call. Catches a symlink at `.worktrees/` pointing elsewhere.
  const worktreesReal = realpathOrNull(worktreesDir);
  if (!worktreesReal || worktreesReal !== fs.realpathSync(worktreesDir)) {
    throw new Error(`path-containment: ${worktreesDir} realpath drift`);
  }
  if (!isRealDirectory(worktreesDir)) {
    throw new Error(`path-containment: ${worktreesDir} is not a real directory (symlink?)`);
  }
  const parentOfTarget = realpathOrNull(path.dirname(worktreePath));
  if (parentOfTarget !== worktreesReal) {
    throw new Error(
      `path-containment: parent of ${worktreePath} (${parentOfTarget}) does not equal ${worktreesReal}`,
    );
  }

  const createOp = 'src/core/InstarWorktreeManager.ts:createWorktree';
  // Pre-prune dangling worktree metadata.
  tryGit(['-C', instarRepo, 'worktree', 'prune'], instarRepo, createOp, 'write');

  // Decide whether the branch already exists.
  const branchExists =
    tryGit(['-C', instarRepo, 'show-ref', '--verify', `refs/heads/${opts.branch}`], instarRepo, createOp, 'read').ok;

  const addArgs = ['-C', instarRepo, 'worktree', 'add'];
  let createdBranch = false;
  if (!branchExists) {
    const base = await resolveBaseBranch(
      instarRepo,
      opts.baseBranch,
      remoteFetchesCanonical ? allowlistedRemote : undefined,
    );
    addArgs.push('-b', opts.branch, worktreePath, base);
    createdBranch = true;
  } else {
    addArgs.push(worktreePath, opts.branch);
  }
  const addResult = tryGit(addArgs, instarRepo, createOp, 'write');
  if (!addResult.ok) {
    throw new Error(classifyWorktreeAddError(addResult.error, worktreePath, instarRepo));
  }

  // Per-worktree git identity. Cosmetic attribution, not authority. Signing
  // configuration (user.signingkey, commit.gpgsign, gpg.format,
  // gpg.ssh.allowedSignersFile) is deliberately untouched.
  setLocalGitIdentity(worktreePath, agentName);
  ensureHuskyHooksActive(worktreePath);

  const shareNodeModules = opts.shareNodeModules ?? true;
  if (shareNodeModules) {
    maybeSymlinkNodeModules(instarRepo, worktreePath);
  }

  // Audit ledger — local and durable mirror.
  const stateDir = opts.stateDir ?? path.join(agentHome, '.instar');
  const sha = tryGit(['-C', instarRepo, 'rev-parse', 'HEAD'], instarRepo, createOp, 'read').ok
    ? git(['-C', instarRepo, 'rev-parse', 'HEAD'], instarRepo, createOp, 'read').slice(0, 7)
    : 'unknown';
  appendLedgerEntry(worktreesDir, stateDir, {
    ts: new Date().toISOString(),
    agent: agentName,
    branch: opts.branch,
    slug,
    worktreePath,
    instarRepo,
    instarRepoSha: sha,
    shareNodeModules,
  });

  return {
    worktreePath,
    branch: opts.branch,
    slug,
    agentHome,
    agentName,
    instarRepo,
    instarRepoSha: sha,
    shareNodeModules,
    createdBranch,
  };
}

export async function resolveBaseBranch(
  repoPath: string,
  override?: string,
  allowlistedRemote?: string,
): Promise<string> {
  if (override && override.trim()) return override.trim();
  // Note: the spec also allows a `worktree.defaultBaseBranch` config override,
  // surfaced via the caller (CLI reads config and passes baseBranch).
  const baseOp = 'src/core/InstarWorktreeManager.ts:resolveBaseBranch';

  // Prefer the remote that won the allowlist check — that is canonical instar
  // by definition. Blindly using origin/HEAD branched fleet agent-home
  // worktrees from the agent's personal FORK, whose default branch is a
  // backup-sync of agent-home FILES (no package.json / src) — an unusable
  // worktree whose husky wiring then silently no-oped (task #82, found by the
  // #829 live re-verify on a real agent home).
  if (allowlistedRemote && allowlistedRemote !== 'origin') {
    const remoteHead = tryGit(
      ['-C', repoPath, 'symbolic-ref', `refs/remotes/${allowlistedRemote}/HEAD`],
      repoPath, baseOp, 'read',
    );
    const headPrefix = `refs/remotes/${allowlistedRemote}/`;
    if (remoteHead.ok && remoteHead.stdout.startsWith(headPrefix)) {
      return `${allowlistedRemote}/${remoteHead.stdout.slice(headPrefix.length)}`;
    }
    // Remote HEAD is often unset for manually-added remotes — fall back to
    // its main, which `git fetch <remote> main` keeps current.
    const remoteMain = tryGit(
      ['-C', repoPath, 'show-ref', '--verify', `refs/remotes/${allowlistedRemote}/main`],
      repoPath, baseOp, 'read',
    );
    if (remoteMain.ok) return `${allowlistedRemote}/main`;
  }

  const head = tryGit(['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath, baseOp, 'read');
  if (head.ok && head.stdout.startsWith('refs/remotes/origin/')) {
    return head.stdout.replace('refs/remotes/origin/', 'origin/');
  }
  // Fall back to local main if origin/HEAD is unset (common in fresh clones).
  const local = tryGit(['-C', repoPath, 'show-ref', '--verify', 'refs/heads/main'], repoPath, baseOp, 'read');
  if (local.ok) return 'main';
  throw new Error('base-branch: could not resolve origin/HEAD and no local main exists');
}

function classifyWorktreeAddError(stderr: string, worktreePath: string, repoPath: string): string {
  const lower = stderr.toLowerCase();
  if (lower.includes('already exists') && lower.includes('not a working tree')) {
    return `worktree add failed — stale metadata for ${worktreePath}. Run: git -C ${repoPath} worktree remove --force ${worktreePath}`;
  }
  if (lower.includes('already exists')) {
    return `worktree add failed — directory ${worktreePath} already exists. Inspect contents then 'rm -rf ${worktreePath}' if safe, then retry.`;
  }
  return `worktree add failed: ${stderr}`;
}

function setLocalGitIdentity(worktreePath: string, agentName: string): void {
  // Set only user.name + user.email. Do not touch signing configuration —
  // global user.signingkey / commit.gpgsign / gpg.format flow through unchanged.
  const idOp = 'src/core/InstarWorktreeManager.ts:setLocalGitIdentity';
  tryGit(['-C', worktreePath, 'config', 'user.name', `Instar Agent (${agentName})`], worktreePath, idOp, 'write');
  tryGit(['-C', worktreePath, 'config', 'user.email', `${agentName}@instar.local`], worktreePath, idOp, 'write');
}

function maybeSymlinkNodeModules(instarRepo: string, worktreePath: string): void {
  const source = path.join(instarRepo, 'node_modules');
  const target = path.join(worktreePath, 'node_modules');
  if (!fs.existsSync(source)) return;
  // Source must be a REAL directory inside the validated repo (not a symlink),
  // matching the bash-helper invariant.
  const lst = fs.lstatSync(source);
  if (!lst.isDirectory()) return;
  if (fs.existsSync(target)) return;
  fs.symlinkSync(source, target);
}

export function ensureHuskyHooksActive(worktreePath: string): void {
  const packageJsonPath = path.join(worktreePath, 'package.json');
  const trackedHookPath = path.join(worktreePath, '.husky', 'pre-commit');
  const shimHookPath = path.join(worktreePath, '.husky', '_', 'pre-commit');
  // A freshly-created instar worktree without package.json + the tracked
  // pre-commit hook is NOT a normal case — it means the worktree was branched
  // from something that is not the instar code tree (live case, task #82: the
  // default base resolved to the agent's personal fork, whose default branch
  // is a backup-sync of agent-home FILES). Silently returning here is what
  // made that worktree look fine while running ZERO commit-time checks. Fail
  // loud with the remedies instead.
  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(trackedHookPath)) {
    throw new Error(
      `worktree base does not look like the instar code tree (missing ` +
      `${!fs.existsSync(packageJsonPath) ? 'package.json' : '.husky/pre-commit'} in ${worktreePath}). ` +
      `The base branch likely points at a fork/backup branch, not canonical instar. ` +
      `Re-run with --base <canonical-remote>/main (e.g. --base upstream/main) or set ` +
      `worktree.defaultBaseBranch in ~/.instar/config.json. ` +
      `Clean up with: git worktree remove --force ${worktreePath}`,
    );
  }

  let prepareScript: unknown;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: { prepare?: unknown };
    };
    prepareScript = pkg.scripts?.prepare;
  } catch {
    throw new Error('husky: package.json is unreadable; cannot verify pre-commit hook activation');
  }
  if (typeof prepareScript !== 'string' || !prepareScript.trim()) {
    throw new Error('husky: package.json has no prepare script; cannot activate pre-commit hook in new worktree');
  }

  if (!hasRunnableHookShim(shimHookPath)) {
    try {
      execFileSync('npm', ['run', 'prepare'], {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
      const stderr = e.stderr ? String(e.stderr).trim() : '';
      throw new Error(
        `husky: prepare failed; pre-commit hook is not active in ${worktreePath}` +
        (stderr ? ` — ${stderr.split('\n').slice(-1)[0]}` : ''),
      );
    }
  }

  if (!hasRunnableHookShim(shimHookPath)) {
    throw new Error('husky: prepare completed but the generated pre-commit shim is still missing or not executable');
  }
}

export function hasRunnableHookShim(shimHookPath: string): boolean {
  try {
    const st = fs.statSync(shimHookPath);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function ensureWorktreesDir(worktreesDir: string): void {
  if (fs.existsSync(worktreesDir)) {
    // Re-assert 0700 every call to recover from drift.
    fs.chmodSync(worktreesDir, 0o700);
  } else {
    fs.mkdirSync(worktreesDir, { recursive: true, mode: 0o700 });
    // mkdirSync's `mode` is masked by umask — re-apply explicitly.
    fs.chmodSync(worktreesDir, 0o700);
  }
  ensureWorktreeSpotlightExclusion(worktreesDir);
}

/**
 * Drop a `.metadata_never_index` marker at the `.worktrees/` container root so
 * macOS Spotlight (mds_stores) + mediaanalysisd skip indexing every worktree
 * beneath it. Worktrees are throwaway full source trees; re-indexing dozens of
 * them is a top OS-level CPU consumer (measured: mediaanalysisd ~80% CPU under a
 * ~120-worktree backlog). The marker is honored recursively for the whole
 * subtree, lives at the container (not inside any worktree, so no git noise),
 * is a harmless no-op on non-macOS, and is idempotent. Returns true if it
 * created the marker, false if it already existed or could not be written.
 *
 * Part of the Responsible Resource Usage standard — OS resource hygiene.
 */
export function ensureWorktreeSpotlightExclusion(worktreesDir: string): boolean {
  const marker = path.join(worktreesDir, '.metadata_never_index');
  try {
    if (fs.existsSync(marker)) return false;
    fs.writeFileSync(marker, '');
    return true;
  } catch {
    // @silent-fallback-ok — a best-effort OS indexing hint. Failure to write it
    // just means Spotlight keeps indexing (the prior behavior); it must never
    // block worktree creation or a migration pass.
    return false;
  }
}

/**
 * Drop a `.metadata_never_index` marker at this agent's Claude Code transcript
 * directory (`<claudeHome>/projects/<encoded-agent-home>`) so macOS Spotlight
 * (mds_stores) stops re-indexing the constantly-appended JSONL session
 * transcripts. These are the single largest Spotlight churn source on a busy
 * agent: every assistant/user turn appends to them and an active home accumulates
 * many GB (measured ~18GB on a busy fleet box), which Spotlight re-indexes on
 * every change — pinning mds_stores at 60-90% of a core. instar already READS
 * these transcripts (TokenLedger / CompactionSentinel), so excluding them from
 * indexing is the matching OS hygiene; nothing usefully Spotlight-searches a
 * Claude JSONL transcript. Claude encodes the project dir by mapping every
 * non-alphanumeric char to '-' (`/Users/justin/.instar/agents/echo` ->
 * `-Users-justin--instar-agents-echo`); we mirror that. Graceful no-op when the
 * transcript dir doesn't exist yet (no sessions run) or on non-macOS; idempotent.
 * Returns true iff it created the marker.
 *
 * Part of the Responsible Resource Usage standard — OS resource hygiene.
 */
export function ensureClaudeTranscriptSpotlightExclusion(
  agentHome: string,
  claudeHome?: string,
): boolean {
  const home = claudeHome ?? path.join(process.env.HOME || os.homedir(), '.claude');
  const encoded = agentHome.replace(/[^a-zA-Z0-9]/g, '-');
  const transcriptDir = path.join(home, 'projects', encoded);
  if (!fs.existsSync(transcriptDir)) return false;
  // Reuse the generic marker-dropper (dir-agnostic despite the name).
  return ensureWorktreeSpotlightExclusion(transcriptDir);
}

/**
 * The high-churn subdirectories of the agent's runtime data dir (`<stateDir>` =
 * `<agentHome>/.instar`). Worktrees (#588), node_modules (#606), and Claude
 * transcripts (#903) are excluded, but the agent's OWN runtime data was never
 * touched — and it is a top OS-indexer fuel source on a busy box:
 *   - `telegram-images/` — every photo a user sends is downloaded here; macOS
 *     `mediaanalysisd` performs vision analysis on each one (measured pinning a
 *     core at ~70-80% against a few hundred accumulated images).
 *   - `server-data/` — SQLite databases (+ WAL/SHM) rewritten continuously by
 *     every feature; constant mutation = constant `mds_stores` re-indexing.
 *   - `logs/` — `server.log` is appended on essentially every tick.
 *   - `state/` — JSON state files rewritten constantly.
 * None of these are usefully Spotlight-searchable (instar reads them via fs, not
 * mdfind), so excluding them is pure OS hygiene.
 */
const AGENT_DATA_SPOTLIGHT_SUBDIRS = ['telegram-images', 'server-data', 'logs', 'state'];

/**
 * Drop a `.metadata_never_index` marker in each high-churn subdir of the agent's
 * runtime data dir (`<stateDir>`) so macOS Spotlight (mds_stores) + mediaanalysisd
 * stop re-indexing the agent's own constantly-mutating images / databases / logs /
 * state. This closes the gap left by the worktree, node_modules, and transcript
 * exclusions — the agent's own `.instar/` data was the remaining unexcluded churn
 * source (measured: mediaanalysisd ~72-78% CPU + mds_stores ~28-48% on a busy box
 * whose ~/.instar was never excluded). Markers sit INSIDE each subdir (gitignored
 * runtime trees → no git noise), are honored recursively, are harmless on
 * non-macOS, and idempotent. Returns the list of subdir names where a marker was
 * newly created (empty if all already present or none exist).
 *
 * Part of the Responsible Resource Usage standard — OS resource hygiene.
 */
export function ensureAgentDataSpotlightExclusion(stateDir: string): string[] {
  const created: string[] = [];
  for (const sub of AGENT_DATA_SPOTLIGHT_SUBDIRS) {
    const dir = path.join(stateDir, sub);
    if (!fs.existsSync(dir)) continue;
    // Reuse the generic marker-dropper (dir-agnostic despite the name).
    if (ensureWorktreeSpotlightExclusion(dir)) created.push(sub);
  }
  return created;
}

// ── Audit ledger ─────────────────────────────────────────────────────────

export interface LedgerEntry {
  ts: string;
  agent: string;
  branch: string;
  slug: string;
  worktreePath: string;
  instarRepo: string;
  instarRepoSha: string;
  shareNodeModules: boolean;
}

export function appendLedgerEntry(
  worktreesDir: string,
  stateDir: string,
  entry: LedgerEntry,
): void {
  const local = path.join(worktreesDir, LOCAL_LEDGER_BASENAME);
  appendLedgerLine(local, entry);

  const auditDir = path.join(stateDir, AUDIT_DIR_NAME);
  fs.mkdirSync(auditDir, { recursive: true });
  const mirror = path.join(auditDir, AUDIT_LEDGER_BASENAME);
  appendLedgerLine(mirror, entry);
}

function appendLedgerLine(filePath: string, entry: LedgerEntry): void {
  // O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC: refuse a pre-planted symlink
  // at the ledger path; new files created 0600.
  // (`O_CLOEXEC` is the default in Node 18+ for fs.open — we still set the
  // mode explicitly so existing files don't widen permissions.)
  const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY |
    fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(filePath, flags, 0o600);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ELOOP') {
      throw new Error(`audit ledger: ${filePath} is a symlink — refused (O_NOFOLLOW)`);
    }
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    const euid = process.geteuid?.() ?? -1;
    if (euid !== -1 && st.uid !== euid) {
      throw new Error(`audit ledger: ${filePath} owner uid ${st.uid} != euid ${euid} — refused`);
    }
    if ((st.mode & 0o077) !== 0) {
      throw new Error(
        `audit ledger: ${filePath} mode 0${(st.mode & 0o777).toString(8)} grants group/other access — refused`,
      );
    }
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

/** Stable hash for a worktree path — used by the (deferred) Layer 4 detector
 *  as the AttentionQueue dedupe key. Exposed here so detector code and tests
 *  cannot drift. */
export function worktreeDedupeKey(worktreePath: string): string {
  return `worktree-misplaced:${crypto.createHash('sha256').update(worktreePath).digest('hex')}`;
}
