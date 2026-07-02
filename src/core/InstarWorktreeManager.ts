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
}

export interface ResolvedAgentHome {
  /** Absolute, real (symlink-resolved) path to the agent home directory. */
  agentHome: string;
  /** Agent name extracted from the trailing path segment. */
  agentName: string;
}

export interface ResolveInstarRepoOptions {
  env?: NodeJS.ProcessEnv;
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
  /** Allowlisted remote.origin.url for the resolved repo. */
  remoteUrl: string;
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
    throw new Error(
      `agent home: ${candidateReal} is not under the instar agents root ${agentsRootReal}`,
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
  const home = opts.homeDir ?? os.homedir();
  const fallbacks = opts.fallbackChain ?? [
    path.join(home, 'Documents', 'Projects', 'instar'),
    path.join(home, 'instar'),
  ];

  const candidates: string[] = [];
  if (env.INSTAR_REPO && env.INSTAR_REPO.trim()) candidates.push(env.INSTAR_REPO.trim());
  candidates.push(...fallbacks);

  const allowlist = new Set<string>(opts.urlAllowlist ?? mergedRepoUrlAllowlist(opts.configPath));

  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = validateInstarRepoCandidate(candidate, allowlist);
    if (result.ok) {
      return { repoPath: result.repoPath, remoteUrl: result.remoteUrl };
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
): { ok: true; repoPath: string; remoteUrl: string } | { ok: false; error: string } {
  if (!candidate || !fs.existsSync(candidate)) {
    return { ok: false, error: 'path does not exist' };
  }
  const real = realpathOrNull(candidate);
  if (!real) return { ok: false, error: 'realpath failed' };

  const op = 'src/core/InstarWorktreeManager.ts:resolveInstarRepo';
  const gitCommon = tryGit(['-C', real, 'rev-parse', '--git-common-dir'], real, op, 'read');
  if (!gitCommon.ok) {
    return { ok: false, error: `not a git repo (${gitCommon.error.split('\n')[0]})` };
  }

  const remote = tryGit(['-C', real, 'config', '--get', 'remote.origin.url'], real, op, 'read');
  if (!remote.ok || !remote.stdout) {
    return { ok: false, error: 'remote.origin.url unset' };
  }
  if (!allowlist.has(remote.stdout)) {
    return {
      ok: false,
      error: `remote.origin.url ${remote.stdout} not in worktree.repoUrlAllowlist`,
    };
  }

  // core.hooksPath, if set, must resolve inside the repo.
  const hooksPath = tryGit(['-C', real, 'config', '--get', 'core.hooksPath'], real, op, 'read');
  if (hooksPath.ok && hooksPath.stdout) {
    const resolvedHooks = path.isAbsolute(hooksPath.stdout)
      ? hooksPath.stdout
      : path.resolve(real, hooksPath.stdout);
    const resolvedHooksReal = realpathOrNull(resolvedHooks);
    if (!resolvedHooksReal || !resolvedHooksReal.startsWith(real + path.sep)) {
      return {
        ok: false,
        error: `core.hooksPath ${hooksPath.stdout} resolves outside the repo`,
      };
    }
  }

  return { ok: true, repoPath: real, remoteUrl: remote.stdout };
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
  const { repoPath: instarRepo } = resolveInstarRepo(opts.resolveInstarRepoOpts);

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

  // Decide whether to use `git worktree add` or `git clone`. When the
  // instar repo lives outside agent home (the normal cross-project case),
  // a worktree's .git pointer file references the parent repo's
  // .git/worktrees/<slug>/ metadata — which the macOS sandbox can revoke
  // mid-session (confirmed 2026-05-22). A `git clone --no-hardlinks`
  // produces a self-contained .git/ directory entirely inside agent home;
  // the parent path can be deleted, revoked, or set on fire and the
  // worktree keeps working. See docs/specs/SENTINEL-REACHABILITY-SPEC.md
  // §B1. INSTAR_WORKTREE_FORCE_WORKTREE=1 forces the legacy path
  // (rollback escape hatch); INSTAR_WORKTREE_FORCE_CLONE=1 forces clone.
  const useClone = shouldCloneInsteadOfWorktree(instarRepo, agentHome);

  let createdBranch = false;

  if (useClone) {
    // Branch resolution happens on the parent first so we can clone the
    // correct ref. If the branch doesn't exist there yet, create it from
    // the resolved base.
    const branchExistsInParent = tryGit(
      ['-C', instarRepo, 'show-ref', '--verify', `refs/heads/${opts.branch}`],
      instarRepo, createOp, 'read',
    ).ok;
    if (!branchExistsInParent) {
      const base = await resolveBaseBranch(instarRepo, opts.baseBranch);
      const branchResult = tryGit(
        ['-C', instarRepo, 'branch', opts.branch, base],
        instarRepo, createOp, 'write',
      );
      if (!branchResult.ok) {
        throw new Error(`branch create failed in source repo: ${branchResult.error}`);
      }
      createdBranch = true;
    }
    // --no-hardlinks ensures pack-file independence: deleting the parent's
    // .git/objects later does not dangle the worktree's references.
    const cloneResult = tryGit(
      ['clone', '--quiet', '--local', '--no-hardlinks', '--branch', opts.branch, instarRepo, worktreePath],
      worktreesDir, createOp, 'write',
    );
    if (!cloneResult.ok) {
      throw new Error(`clone-isolation failed: ${cloneResult.error}`);
    }
  } else {
    // In-tree worktree: source is already under agent home, sandbox hazard
    // doesn't apply, and worktree is cheaper than clone.
    tryGit(['-C', instarRepo, 'worktree', 'prune'], instarRepo, createOp, 'write');
    const branchExists =
      tryGit(['-C', instarRepo, 'show-ref', '--verify', `refs/heads/${opts.branch}`], instarRepo, createOp, 'read').ok;
    const addArgs = ['-C', instarRepo, 'worktree', 'add'];
    if (!branchExists) {
      const base = await resolveBaseBranch(instarRepo, opts.baseBranch);
      addArgs.push('-b', opts.branch, worktreePath, base);
      createdBranch = true;
    } else {
      addArgs.push(worktreePath, opts.branch);
    }
    const addResult = tryGit(addArgs, instarRepo, createOp, 'write');
    if (!addResult.ok) {
      throw new Error(classifyWorktreeAddError(addResult.error, worktreePath, instarRepo));
    }
  }

  // Per-worktree git identity. Cosmetic attribution, not authority. Signing
  // configuration (user.signingkey, commit.gpgsign, gpg.format,
  // gpg.ssh.allowedSignersFile) is deliberately untouched.
  setLocalGitIdentity(worktreePath, agentName);

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

async function resolveBaseBranch(repoPath: string, override?: string): Promise<string> {
  if (override && override.trim()) return override.trim();
  // Note: the spec also allows a `worktree.defaultBaseBranch` config override,
  // surfaced via the caller (CLI reads config and passes baseBranch).
  const baseOp = 'src/core/InstarWorktreeManager.ts:resolveBaseBranch';
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

/**
 * Decide whether to create a self-contained clone (--local --no-hardlinks)
 * instead of a git worktree. True when the source repo lives outside agent
 * home — when the sandbox-revocation hazard applies. Honors the same env
 * overrides as WorktreeManager's identically-named method for consistency.
 *
 * Spec: docs/specs/SENTINEL-REACHABILITY-SPEC.md §B1.
 */
export function shouldCloneInsteadOfWorktree(instarRepo: string, agentHome: string): boolean {
  if (process.env.INSTAR_WORKTREE_FORCE_WORKTREE === '1') return false;
  if (process.env.INSTAR_WORKTREE_FORCE_CLONE === '1') return true;
  try {
    const sourceReal = fs.realpathSync(instarRepo);
    let homeReal = agentHome;
    try { homeReal = fs.realpathSync(agentHome); } catch { /* dir may not exist yet */ }
    return !sourceReal.startsWith(homeReal + path.sep) && sourceReal !== homeReal;
  } catch {
    // realpath failed — be conservative and clone (safer).
    return true;
  }
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

function ensureWorktreesDir(worktreesDir: string): void {
  if (fs.existsSync(worktreesDir)) {
    // Re-assert 0700 every call to recover from drift.
    fs.chmodSync(worktreesDir, 0o700);
    return;
  }
  fs.mkdirSync(worktreesDir, { recursive: true, mode: 0o700 });
  // mkdirSync's `mode` is masked by umask — re-apply explicitly.
  fs.chmodSync(worktreesDir, 0o700);
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

// ── Health check ─────────────────────────────────────────────────────────

export type WorktreeHealthStatus =
  | 'ok'                       // self-contained .git/ directory; parent reachable
  | 'broken-pointer'           // .git is a file pointing into an inaccessible parent path
  | 'dirty-migration-pending'  // .git is a file pointing into agent-accessible parent, but worktree has uncommitted changes
  | 'detached-no-git'          // worktree directory exists but has no .git at all
  | 'unknown';

export interface WorktreeHealthEntry {
  slug: string;
  worktreePath: string;
  status: WorktreeHealthStatus;
  gitdirTarget?: string;   // for .git-file worktrees, the target it points at
  parentReachable?: boolean;
  detail?: string;
}

/**
 * Inspect every worktree under `<agentHome>/.worktrees/` and classify its
 * health. Used by the `instar worktree health` CLI command and by the
 * GET /worktree/health route surfaced in the dashboard. Read-only.
 */
export function inspectWorktreeHealth(agentHome: string): WorktreeHealthEntry[] {
  const worktreesDir = path.join(agentHome, '.worktrees');
  if (!fs.existsSync(worktreesDir)) return [];

  const entries: WorktreeHealthEntry[] = [];
  for (const slug of fs.readdirSync(worktreesDir)) {
    if (slug.startsWith('.')) continue; // ignore .ledger.jsonl etc.
    const worktreePath = path.join(worktreesDir, slug);
    let lst: fs.Stats;
    try { lst = fs.lstatSync(worktreePath); } catch { continue; }
    if (!lst.isDirectory()) continue;

    const gitMarker = path.join(worktreePath, '.git');
    let markerLst: fs.Stats | null = null;
    try { markerLst = fs.lstatSync(gitMarker); } catch { /* no .git at all */ }

    if (!markerLst) {
      entries.push({ slug, worktreePath, status: 'detached-no-git' });
      continue;
    }

    if (markerLst.isDirectory()) {
      entries.push({ slug, worktreePath, status: 'ok', parentReachable: true });
      continue;
    }

    // .git is a file → worktree pointer. Read it and check the gitdir target.
    let gitdirContent = '';
    try { gitdirContent = fs.readFileSync(gitMarker, 'utf-8'); } catch { /* fall through */ }
    const m = gitdirContent.match(/^gitdir:\s*(.+?)\s*$/m);
    const gitdirTarget = m ? m[1] : undefined;
    if (!gitdirTarget) {
      entries.push({ slug, worktreePath, status: 'unknown', detail: '.git file has no gitdir line' });
      continue;
    }

    // Is the target reachable?
    let parentReachable = false;
    try { fs.accessSync(gitdirTarget, fs.constants.R_OK); parentReachable = true; } catch { /* unreachable */ }

    if (!parentReachable) {
      entries.push({ slug, worktreePath, status: 'broken-pointer', gitdirTarget, parentReachable: false });
      continue;
    }

    // Reachable now but worktree-pointer style — still vulnerable to mid-
    // session sandbox revocation. Surface as a migration candidate; if the
    // worktree has uncommitted changes, mark it pending operator action.
    let dirty = false;
    try {
      // git status --porcelain; if anything is staged or unstaged → dirty
      const r = tryGit(['-C', worktreePath, 'status', '--porcelain'], worktreePath, 'inspectWorktreeHealth', 'read');
      dirty = r.ok && r.stdout.trim().length > 0;
    } catch { /* if git fails, treat as dirty (safer) */ dirty = true; }

    entries.push({
      slug,
      worktreePath,
      status: dirty ? 'dirty-migration-pending' : 'broken-pointer',
      gitdirTarget,
      parentReachable: true,
      detail: dirty ? 'uncommitted changes prevent auto-migration' : 'migration candidate (parent reachable now, but worktree-pointer is sandbox-fragile)',
    });
  }
  return entries;
}
