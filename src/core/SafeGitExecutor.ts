// safe-git-allow: this file is the single funnel point for destructive git invocations.
/**
 * SafeGitExecutor — the single funnel for destructive git invocations.
 *
 * Background: PR #96 (DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC) added
 * `assertNotInstarSourceTree` to the constructors of `GitSyncManager`,
 * `BranchManager`, and `HandoffManager`. Five days later, Incident B recurred
 * because test fixtures invoked `execFileSync('git', ['add', '-A'], { cwd })`
 * directly — bypassing the manager constructors entirely.
 *
 * This module is the funnel layer described in
 * `docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md`. Every
 * destructive git invocation in the codebase routes through one of three
 * methods on this class, each of which calls `assertNotInstarSourceTree`
 * BEFORE spawning git. Read-only verbs may go through `readSync`, which
 * also runs the assertion (defense-in-depth against repo-local aliases).
 *
 * Constraints enforced:
 *   - Every directory the subprocess could mutate is canonicalized via
 *     `realpathSync` and passed through `assertNotInstarSourceTree`. This
 *     covers `opts.cwd`, the `-C <dir>` target, and the path values in
 *     `--git-dir=<path>`, `--work-tree=<path>`. Any one being the instar
 *     source causes the call to throw before subprocess spawn.
 *   - Caller-supplied env has the git-redirection denylist stripped:
 *     GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
 *     GIT_COMMON_DIR, GIT_NAMESPACE, GIT_CONFIG*, GIT_CEILING_DIRECTORIES,
 *     GIT_DISCOVERY_ACROSS_FILESYSTEM.
 *   - GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_SYSTEM=/dev/null +
 *     GIT_CONFIG_NOSYSTEM=1 are injected unconditionally. This disables
 *     user-level and system-level git config (including aliases that could
 *     rebind a "read-only" verb to a destructive command).
 *   - A JSON line is appended to .instar/audit/destructive-ops.jsonl per
 *     call (fail-soft on log write failure).
 */

import {
  execFileSync,
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNotInstarSourceTree,
  SourceTreeGuardError,
} from './SourceTreeGuard.js';

// ── Verb classification ─────────────────────────────────────────────

/**
 * Verbs treated as destructive. Closed enumeration; additions are spec changes.
 */
export const DESTRUCTIVE_GIT_VERBS: ReadonlySet<string> = new Set([
  'add',
  'am',
  'apply',
  'branch', // shape-checked: bare `branch <name>` is destructive
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'fetch',
  'gc',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'submodule',
  'switch',
  'tag',
  'update-ref',
  'worktree', // shape-checked: `worktree list` is read-only
  'prune',
  'notes',
  'replace',
  'filter-branch',
  'remote', // shape-checked: `remote get-url` is read-only
  'config', // shape-checked: `config --get` is read-only
  'format-patch', // shape-checked: --inline is destructive
]);

/**
 * Read-only verbs explicitly safe to call. Closed enumeration.
 */
export const READONLY_GIT_VERBS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'describe',
  'name-rev',
  'blame',
  'cat-file',
  'cherry', // read-only: lists +/- patch-equivalence vs an upstream; no mutation
  'grep',
  'shortlog',
  'count-objects',
  'fsck',
  'var',
  'version',
  '--version',
  'help',
  'write-tree',
  'interpret-trailers',
  'check-ref-format',
  'symbolic-ref',
  'show-ref',
  'for-each-ref',
  'merge-base',
  'reflog', // read-only by default; reflog expire/delete is destructive (caller must use execSync)
  'hash-object',
  'config', // overlap with destructive set; readSync shape-check enforces --get only
  'remote', // overlap; readSync shape-check enforces list/get-url only
  'branch', // overlap; readSync shape-check enforces --list / -l / --show-current / -v
  'worktree', // overlap; readSync shape-check enforces list only
  'format-patch', // overlap; readSync shape-check rejects --inline
  'stash', // shape-check: `stash list` / `stash show` allowed
]);

/**
 * Verbs that are "data-pull": they touch the object database and FETCH_HEAD
 * but DO NOT modify the working tree, committed refs (heads/tags/remotes),
 * or any source file. From SourceTreeGuard's "protect the instar source"
 * standpoint they are read-tier. Permitted on the instar source tree ONLY
 * when the caller opts in via `SafeGitOptions.sourceTreeReadOk: true`.
 *
 * Currently: `fetch` only. (`ls-remote` is pure-read and already in
 * READONLY_GIT_VERBS — it goes through readSync which never trips the
 * source-tree guard.)
 */
export const SOURCE_TREE_READ_TIER_VERBS: ReadonlySet<string> = new Set([
  // data-pull verbs (execSync path)
  'fetch',
  // read-tier verbs the watchdog + reconciler need against the source tree
  // (readSync path — defense-in-depth source-tree check also gates these,
  // so the bypass must work for both methods)
  'rev-parse',
  'ls-tree',
  'show',
  'log',
  'diff',
  'cat-file',
  'merge-base',
  'remote', // shape-checked to list/get-url only; needed by resolveCanonicalRemote
  // read-tier verbs the AgentWorktreeReaper needs against the source tree to
  // decide whether a worktree is reclaimable. Both are pure reads (no mutation
  // possible): `status --porcelain` for cleanliness, `cherry` for merged-detection.
  'status',
  'cherry',
]);

// ── Env denylist ────────────────────────────────────────────────────

const GIT_ENV_DENYLIST: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);

// Cache of host's git identity, read once from gitconfig (only if env vars
// don't supply it). Identity is not an alias-attack vector — it's just
// who-am-I. Neutralizing gitconfig kills it, so we re-inject as env vars
// in sanitizeEnv. We always check env vars first on every call, so tests
// that set GIT_AUTHOR_*/GIT_COMMITTER_* can short-circuit the gitconfig read.
let _cachedConfigIdentity: { name?: string; email?: string } | null = null;
function getHostGitIdentity(): { name?: string; email?: string } {
  // Env vars always win — checked on every call so tests setting them can
  // bypass the gitconfig read entirely.
  const fromEnv: { name?: string; email?: string } = {};
  if (process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME) {
    fromEnv.name = process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME;
  }
  if (process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL) {
    fromEnv.email = process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL;
  }
  if (fromEnv.name && fromEnv.email) return fromEnv;
  // Fall back to host gitconfig — read once and cache.
  if (!_cachedConfigIdentity) {
    _cachedConfigIdentity = {};
    try {
      _cachedConfigIdentity.name = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim() || undefined;
    } catch { /* not configured */ }
    try {
      _cachedConfigIdentity.email = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim() || undefined;
    } catch { /* not configured */ }
  }
  return {
    name: fromEnv.name ?? _cachedConfigIdentity.name,
    email: fromEnv.email ?? _cachedConfigIdentity.email,
  };
}

// ── Per-agent identity isolation (Caroline-class gap 1, Phase-3 Inc-P3a) ──
//
// Git's native precedence puts GIT_AUTHOR_*/GIT_COMMITTER_* env vars ABOVE
// repo-local config. On a shared machine that precedence is exactly the
// credential/identity-bleed exposure: an agent spawned from a shell that
// exports another person's GIT_AUTHOR_NAME silently commits as that person,
// even though the agent's worktree has its own local user.name/user.email
// (set by `instar worktree create` / init). The fix: when the target repo
// HAS a local identity configured, the funnel strips inherited identity env
// vars so the repo-local identity — the per-agent identity — always wins.
// Repos WITHOUT a local identity keep the long-standing host-identity
// behavior (injected only-if-empty) so non-agent installs don't break
// with "Author identity unknown".
const IDENTITY_ENV_VARS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

// Cache of "does this repo have a local user.name AND user.email" keyed on
// the directory we run git in. Local config is stable for the life of a
// process; tests reset via _resetLocalIdentityCacheForTest.
//
// IMPORTANT: this probe reads .git/config via fs, NOT via a git subprocess.
// Spawning `git config --local` here would route through child_process — and
// unit tests that mock node:child_process with scripted mockReturnValueOnce
// sequences (e.g. GitSync.test.ts) would have those sequences consumed and
// misaligned by the probe. The fs read is also faster and side-effect-free.
const _localIdentityCache = new Map<string, boolean>();

/** Candidate config files that hold "repo-local" identity for `dir`. */
function localConfigCandidates(dir: string): string[] {
  const dotGit = path.join(dir, '.git');
  let st: fs.Stats;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return []; /* @silent-fallback-ok — not a git repo: legacy host-identity behavior applies */
  }
  if (st.isDirectory()) return [path.join(dotGit, 'config')];
  // Linked worktree: .git is a file containing "gitdir: <path>". Its local
  // config is the COMMON repo config (and config.worktree when the
  // extensions.worktreeConfig overlay is enabled) — check both.
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
    if (!m) return [];
    const gitdir = path.resolve(dir, m[1]);
    const candidates: string[] = [path.join(gitdir, 'config.worktree')];
    const commondirFile = path.join(gitdir, 'commondir');
    if (fs.existsSync(commondirFile)) {
      const common = path.resolve(gitdir, fs.readFileSync(commondirFile, 'utf-8').trim());
      candidates.push(path.join(common, 'config'));
    } else {
      candidates.push(path.join(gitdir, 'config'));
    }
    return candidates;
  } catch {
    return []; /* @silent-fallback-ok — unreadable worktree pointer: legacy host-identity behavior applies */
  }
}

/** Minimal git-config parse: does the [user] section define `key`? */
function configDefines(file: string, key: 'name' | 'email'): boolean {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return false; /* @silent-fallback-ok — absent candidate file is simply not a source */
  }
  let inUser = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inUser = /^\[user\]/i.test(line);
      continue;
    }
    if (inUser && new RegExp(`^${key}\\s*=\\s*\\S`).test(line)) return true;
  }
  return false;
}

function repoHasLocalIdentity(cwd: string): boolean {
  let key: string;
  try {
    key = path.resolve(cwd);
  } catch {
    return false; /* @silent-fallback-ok — unresolvable cwd: legacy host-identity behavior applies */
  }
  const cached = _localIdentityCache.get(key);
  if (cached !== undefined) return cached;
  const candidates = localConfigCandidates(key);
  const has =
    candidates.some((f) => configDefines(f, 'name')) &&
    candidates.some((f) => configDefines(f, 'email'));
  _localIdentityCache.set(key, has);
  return has;
}
function _resetLocalIdentityCacheForTest(): void {
  _localIdentityCache.clear();
}

function sanitizeEnv(callerEnv?: NodeJS.ProcessEnv, cwd?: string): NodeJS.ProcessEnv {
  // Start from a copy of process.env, then strip the denylist, then strip
  // anything the caller supplied that's on the denylist or that matches
  // GIT_CONFIG_KEY_* / GIT_CONFIG_VALUE_*.
  const merged: NodeJS.ProcessEnv = { ...process.env, ...(callerEnv || {}) };
  for (const k of Object.keys(merged)) {
    if (GIT_ENV_DENYLIST.has(k)) {
      delete merged[k];
      continue;
    }
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) {
      delete merged[k];
    }
  }
  // Per-agent identity isolation: a repo with its OWN local identity is
  // authoritative — strip inherited identity env vars so git falls through
  // to the repo-local config (the agent's identity), never a name that
  // leaked in from the spawning shell or another principal on the machine.
  if (repoHasLocalIdentity(cwd ?? process.cwd())) {
    for (const k of IDENTITY_ENV_VARS) delete merged[k];
  } else {
    // Preserve host git identity before we neutralize global config — without
    // this, every commit through SafeGitExecutor would fail with "Author
    // identity unknown" because the global config is at /dev/null. Identity is
    // not an alias-attack vector; alias rebinding is.
    const id = getHostGitIdentity();
    if (id.name && !merged.GIT_AUTHOR_NAME) merged.GIT_AUTHOR_NAME = id.name;
    if (id.email && !merged.GIT_AUTHOR_EMAIL) merged.GIT_AUTHOR_EMAIL = id.email;
    if (id.name && !merged.GIT_COMMITTER_NAME) merged.GIT_COMMITTER_NAME = id.name;
    if (id.email && !merged.GIT_COMMITTER_EMAIL) merged.GIT_COMMITTER_EMAIL = id.email;
  }
  // Inject unconditional config disables.
  merged.GIT_CONFIG_GLOBAL = '/dev/null';
  merged.GIT_CONFIG_SYSTEM = '/dev/null';
  merged.GIT_CONFIG_NOSYSTEM = '1';
  return merged;
}

// ── Pre-verb global flags (a closed set) ────────────────────────────

const PRE_VERB_FLAGS_TAKING_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
]);

const PRE_VERB_FLAGS_NO_VALUE: ReadonlySet<string> = new Set([
  '--bare',
  '--no-pager',
  '-P',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--exec-path', // when used without `=` it's actually informational; allow
  '-p',
  '--paginate',
  '--no-optional-locks',
]);

interface ExtractedTargets {
  verb: string;
  /** All directories the subprocess could mutate (canonical). Includes:
   * - opts.cwd
   * - the `-C <dir>` target
   * - the path values in `--git-dir=<path>` and `--work-tree=<path>`
   *   (and the equivalent `-C <dir>` form)
   */
  targets: string[];
}

/**
 * Walk the args array skipping leading pre-verb global flags. Return:
 *   { verb, targets: [opts.cwd, -C target, --git-dir target, --work-tree target] }
 *
 * Targets are canonicalized via `realpathSync`. If realpath fails on an
 * existing path the raw value is passed through; the assertion handles
 * uncanonicalizable inputs in fail-closed fashion.
 */
function extractVerbAndTargets(
  args: readonly string[],
  cwd: string | undefined,
): ExtractedTargets {
  // If cwd is not given but the args contain a `-C <dir>` redirect, default
  // to that directory rather than process.cwd(). This preserves the
  // semantics of `execFileSync('git', ['-C', dir, ...])` calls that pre-date
  // the migration to SafeGitExecutor and didn't pass an explicit cwd.
  let effectiveCwd = cwd;
  if (effectiveCwd === undefined) {
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-C') {
        effectiveCwd = args[i + 1];
        break;
      }
    }
    effectiveCwd = effectiveCwd ?? process.cwd();
  }
  const targets: string[] = [canonicalize(effectiveCwd)];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === undefined) break;

    if (a === '-C') {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`SafeGitExecutor: \`-C\` flag missing value: ${args.join(' ')}`);
      }
      targets.push(canonicalize(next));
      i += 2;
      continue;
    }
    if (a === '-c') {
      // -c key=value — skip pair, no target.
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`SafeGitExecutor: \`-c\` flag missing value: ${args.join(' ')}`);
      }
      i += 2;
      continue;
    }
    if (a.startsWith('--git-dir=')) {
      const value = a.slice('--git-dir='.length);
      targets.push(canonicalize(value));
      i += 1;
      continue;
    }
    if (a === '--git-dir') {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`SafeGitExecutor: \`--git-dir\` flag missing value: ${args.join(' ')}`);
      }
      targets.push(canonicalize(next));
      i += 2;
      continue;
    }
    if (a.startsWith('--work-tree=')) {
      const value = a.slice('--work-tree='.length);
      targets.push(canonicalize(value));
      i += 1;
      continue;
    }
    if (a === '--work-tree') {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`SafeGitExecutor: \`--work-tree\` flag missing value: ${args.join(' ')}`);
      }
      targets.push(canonicalize(next));
      i += 2;
      continue;
    }
    if (a.startsWith('--namespace=')) {
      i += 1;
      continue;
    }
    if (a === '--namespace') {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`SafeGitExecutor: \`--namespace\` flag missing value: ${args.join(' ')}`);
      }
      i += 2;
      continue;
    }
    if (PRE_VERB_FLAGS_NO_VALUE.has(a)) {
      i += 1;
      continue;
    }
    // Not a recognized pre-verb flag — must be the verb.
    if (a.startsWith('-')) {
      // Unrecognized leading flag — fail loud (mirrors git's own conservative behavior).
      throw new Error(
        `SafeGitExecutor: unrecognized pre-verb flag '${a}' in args ${JSON.stringify(args)}; ` +
          `add it to PRE_VERB_FLAGS_NO_VALUE or PRE_VERB_FLAGS_TAKING_VALUE if it is a legitimate git global option.`,
      );
    }
    return { verb: a, targets: dedupeTargets(targets) };
  }
  throw new Error(`SafeGitExecutor: no verb found in args ${JSON.stringify(args)}`);
}

function canonicalize(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    // realpath failed (path doesn't exist, EACCES, etc.) — return resolved
    // absolute. The assertion handles non-existent inputs via its
    // nearest-existing-ancestor walk.
    try {
      return path.resolve(p);
    } catch {
      return p;
    }
  }
}

function dedupeTargets(targets: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of targets) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ── Shape checks for ambiguous verbs ────────────────────────────────

/**
 * Returns true if the args under a `branch` verb describe a read-only
 * invocation (`branch --list`, `branch -l`, `branch --show-current`,
 * `branch -v` (no name), bare `branch` (list mode)). Returns false for
 * destructive shapes (`branch <name>`, `branch -d`, `branch -D`,
 * `branch -m`, `branch -M`, `branch --set-upstream-to=`, etc.).
 */
function isReadOnlyBranchInvocation(verbArgs: readonly string[]): boolean {
  // verbArgs is the slice AFTER the `branch` verb. If empty, that's `git branch` (list).
  if (verbArgs.length === 0) return true;
  const destructiveFlags = new Set([
    '-d',
    '-D',
    '--delete',
    '-m',
    '-M',
    '--move',
    '-c',
    '-C',
    '--copy',
    '--unset-upstream',
    '--edit-description',
    '--track',
    '--no-track',
  ]);
  for (const a of verbArgs) {
    if (destructiveFlags.has(a)) return false;
    if (a.startsWith('--set-upstream')) return false;
    if (!a.startsWith('-')) {
      // Bare positional arg = branch name = create branch (destructive).
      return false;
    }
  }
  return true;
}

function isReadOnlyRemoteInvocation(verbArgs: readonly string[]): boolean {
  if (verbArgs.length === 0) return true; // `git remote` — list mode
  const sub = verbArgs[0];
  if (sub === '-v' || sub === '--verbose') return true;
  if (sub === 'show' || sub === 'get-url') return true;
  return false;
}

function isReadOnlyWorktreeInvocation(verbArgs: readonly string[]): boolean {
  if (verbArgs.length === 0) return false;
  return verbArgs[0] === 'list';
}

function isReadOnlyConfigInvocation(verbArgs: readonly string[]): boolean {
  // Read-only config: --get, --get-all, --get-regexp, --list, -l, --get-color,
  // --get-colorbool. Destructive: bare set, --add, --unset, --replace-all,
  // --rename-section, --remove-section.
  for (const a of verbArgs) {
    if (a === '--get' || a === '--get-all' || a === '--get-regexp') return true;
    if (a === '--list' || a === '-l') return true;
    if (a === '--get-color' || a === '--get-colorbool') return true;
    if (a === '--get-urlmatch') return true;
  }
  return false;
}

function isReadOnlyFormatPatchInvocation(verbArgs: readonly string[]): boolean {
  // format-patch is read-only by default. --inline rewrites in-tree files
  // and is destructive; it forces the caller to use execSync.
  for (const a of verbArgs) {
    if (a === '--inline') return false;
  }
  return true;
}

function isReadOnlyStashInvocation(verbArgs: readonly string[]): boolean {
  if (verbArgs.length === 0) return false;
  const sub = verbArgs[0];
  return sub === 'list' || sub === 'show';
}

function isReadOnlyReflogInvocation(verbArgs: readonly string[]): boolean {
  if (verbArgs.length === 0) return true;
  const sub = verbArgs[0];
  // Default subcommand is `show` (read-only). `expire`, `delete` mutate refs.
  return sub === 'show' || sub === 'exists';
}

/**
 * Ambiguous-verb shape check. Returns true if (verb, verbArgs) describes
 * a read-only invocation. Returns false for unambiguously-destructive
 * shapes. Returns null if the verb isn't ambiguous (caller uses verb-set
 * membership).
 */
function isReadOnlyShape(
  verb: string,
  verbArgs: readonly string[],
): boolean | null {
  switch (verb) {
    case 'branch':
      return isReadOnlyBranchInvocation(verbArgs);
    case 'remote':
      return isReadOnlyRemoteInvocation(verbArgs);
    case 'worktree':
      return isReadOnlyWorktreeInvocation(verbArgs);
    case 'config':
      return isReadOnlyConfigInvocation(verbArgs);
    case 'format-patch':
      return isReadOnlyFormatPatchInvocation(verbArgs);
    case 'stash':
      return isReadOnlyStashInvocation(verbArgs);
    case 'reflog':
      return isReadOnlyReflogInvocation(verbArgs);
    default:
      return null;
  }
}

/** Return the verbArgs (slice after the verb), accounting for pre-verb flags. */
function sliceAfterVerb(
  args: readonly string[],
  verb: string,
): readonly string[] {
  const idx = args.indexOf(verb);
  if (idx < 0) return [];
  return args.slice(idx + 1);
}

// ── Audit log ───────────────────────────────────────────────────────

interface AuditEntry {
  timestamp: string;
  executor: 'git' | 'fs';
  operation: string;
  verb?: string;
  target: string;
  outcome: 'allowed' | 'denied';
  reason?: string;
  caller?: string;
}

/**
 * Where to write audit lines. Override via env for tests.
 *   INSTAR_AUDIT_LOG_DIR — directory for the JSONL file.
 *   INSTAR_AUDIT_LOG_DISABLED=1 — skip audit logging entirely.
 */
function auditLogPath(): string | null {
  if (process.env.INSTAR_AUDIT_LOG_DISABLED === '1') return null;
  const overrideDir = process.env.INSTAR_AUDIT_LOG_DIR;
  if (overrideDir) {
    return path.join(overrideDir, 'destructive-ops.jsonl');
  }
  // Default: <cwd>/.instar/audit/destructive-ops.jsonl
  return path.join(process.cwd(), '.instar', 'audit', 'destructive-ops.jsonl');
}

export function appendAuditEntry(entry: AuditEntry): void {
  const file = auditLogPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Fail-soft: writing audit must never block the operation.
    try {
      process.stderr.write(
        `[SafeGitExecutor] audit log write failed: ${(err as Error).message}\n`,
      );
    } catch {
      // ignore
    }
  }
}

function captureCallerFrame(): string {
  const e = new Error();
  const stack = (e.stack || '').split('\n');
  // Skip 0 (Error), 1 (this fn), 2 (caller in this file), pick 3.
  const frame = stack[3] || stack[2] || '';
  return frame.trim();
}

// ── Public types ────────────────────────────────────────────────────

export interface SafeGitOptions {
  /** The directory the git command will mutate. Defaults to process.cwd(). */
  cwd?: string;
  /** Caller label for error messages and audit log. */
  operation: string;
  /** stdio passthrough, default 'pipe'. Accepts the same shapes execFileSync does. */
  stdio?: 'pipe' | 'inherit' | 'ignore' | Array<'pipe' | 'inherit' | 'ignore' | number | null | undefined>;
  /** Encoding for return value, default 'utf-8'. */
  encoding?: BufferEncoding;
  /** Timeout in ms, default 30000. */
  timeout?: number;
  /** Env passthrough — denylist for git-redirection variables applied. */
  env?: NodeJS.ProcessEnv;
  /** Optional: input string for the subprocess stdin. */
  input?: string | Buffer;
  /** Maximum buffer for stdout/stderr (execFileSync). */
  maxBuffer?: number;
  /**
   * Opt-in: allow execSync/spawn against the instar source tree for a small
   * allowlist of data-pull verbs that do not mutate committed refs or the
   * working tree (currently `fetch` and `ls-remote`). Defaults false.
   *
   * Why this exists: SourceTreeGuard refuses non-readonly git ops on the
   * instar source tree (the 2026-04-22 incident-class). But the release-
   * readiness watchdog (LAYER B of RELEASE-READINESS-VISIBILITY-SPEC) and
   * its sibling FeatureRolloutReconciler canonical scan (LAYER C) NEED to
   * pull the canonical `main` ref into the agent's own instar checkout —
   * by-definition a source tree — to do their job. `git fetch <remote>
   * <branch> --no-tags --no-recurse-submodules` writes only to FETCH_HEAD
   * (transient) and the object database; it does not modify the working
   * tree or any committed refs, so from the source-protection standpoint
   * it is read-tier. `ls-remote` is pure read. This flag is the narrow,
   * audited escape hatch the spec referenced.
   */
  sourceTreeReadOk?: boolean;
  /**
   * Opt-in: allow the InstarWorktreeManager's narrow source-tree operations.
   *
   * `instar worktree create` must run against a validated instar source
   * checkout to create a sibling worktree. That requires a tiny set of git
   * reads, `git worktree add/prune`, and per-worktree `user.name` /
   * `user.email` config writes. This flag does not allow general source-tree
   * mutation; every permitted shape is enumerated by
   * `isSourceTreeWorktreeManagerInvocation`.
   */
  sourceTreeWorktreeManagerOk?: boolean;
}

// ── Errors ─────────────────────────────────────────────────────────

export class SafeGitExecutorError extends Error {
  readonly code = 'INSTAR_SAFE_GIT_EXECUTOR';
  constructor(message: string) {
    super(message);
    this.name = 'SafeGitExecutorError';
  }
}

// ── The funnel ──────────────────────────────────────────────────────

export class SafeGitExecutor {
  /**
   * Synchronous destructive git execution.
   *
   * 1. Extract the verb and ALL target directories from args + opts.cwd.
   * 2. Canonicalize each target and call assertNotInstarSourceTree on each.
   * 3. Verify the verb is in DESTRUCTIVE_GIT_VERBS (or is an ambiguous verb
   *    in destructive shape). Read-only verbs throw — callers must use readSync.
   * 4. Strip env denylist; inject GIT_CONFIG_GLOBAL/SYSTEM=/dev/null.
   * 5. Spawn git via execFileSync; return stdout.
   *
   * Throws SourceTreeGuardError if any target is the instar source tree.
   * Throws SafeGitExecutorError on classification mismatch or arg errors.
   */
  static execSync(args: readonly string[], opts: SafeGitOptions): string {
    const { verb, targets } = extractVerbAndTargets(args, opts.cwd);
    const verbArgs = sliceAfterVerb(args, verb);

    // Run source-tree assertion against every target — unless the caller
    // explicitly opted into the narrow data-pull allowlist (fetch / etc.)
    // for the documented LAYER B + LAYER C canonical-ref read path. See
    // SafeGitOptions.sourceTreeReadOk for the rationale.
    if (!isSourceTreeCheckBypassed(verb, verbArgs, opts)) {
      runSourceTreeChecks(targets, opts.operation, 'git', verb);
    } else {
      audit('git', opts.operation, verb, targets[0], 'allowed', 'sourceTree-bypass');
    }

    // Verb classification.
    const ambiguousReadOnly = isReadOnlyShape(verb, verbArgs);
    if (ambiguousReadOnly === true) {
      // The verb is ambiguous and the shape is read-only — caller used the
      // wrong method. Fail loud rather than silently allow.
      audit('git', opts.operation, verb, targets[0], 'denied', 'read-only-shape-via-execSync');
      throw new SafeGitExecutorError(
        `SafeGitExecutor.execSync called with read-only shape '${verb} ${verbArgs.join(' ')}' — use SafeGitExecutor.readSync instead.`,
      );
    }
    if (ambiguousReadOnly === null && !DESTRUCTIVE_GIT_VERBS.has(verb)) {
      // Pure read-only verb routed through execSync.
      audit('git', opts.operation, verb, targets[0], 'denied', 'readonly-verb-via-execSync');
      throw new SafeGitExecutorError(
        `SafeGitExecutor.execSync called with read-only verb '${verb}' — use SafeGitExecutor.readSync instead.`,
      );
    }

    const env = sanitizeEnv(opts.env, opts.cwd);

    let stdout: string;
    try {
      stdout = execFileSync('git', args as string[], {
        cwd: opts.cwd,
        stdio: opts.stdio ?? 'pipe',
        encoding: opts.encoding ?? 'utf-8',
        timeout: opts.timeout ?? 30000,
        env,
        input: opts.input,
        maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      }) as string;
    } catch (err) {
      audit('git', opts.operation, verb, targets[0], 'denied', `subprocess-error: ${(err as Error).message}`);
      throw err;
    }
    audit('git', opts.operation, verb, targets[0], 'allowed');
    return stdout || '';
  }

  /**
   * Async/streaming variant. Same guard semantics as execSync.
   */
  static spawn(args: readonly string[], opts: SafeGitOptions): ChildProcess {
    const { verb, targets } = extractVerbAndTargets(args, opts.cwd);
    const verbArgs = sliceAfterVerb(args, verb);
    if (!isSourceTreeCheckBypassed(verb, verbArgs, opts)) {
      runSourceTreeChecks(targets, opts.operation, 'git', verb);
    } else {
      audit('git', opts.operation, verb, targets[0], 'allowed', 'sourceTree-bypass');
    }

    const ambiguousReadOnly = isReadOnlyShape(verb, verbArgs);
    if (ambiguousReadOnly === true) {
      audit('git', opts.operation, verb, targets[0], 'denied', 'read-only-shape-via-spawn');
      throw new SafeGitExecutorError(
        `SafeGitExecutor.spawn called with read-only shape '${verb}' — use SafeGitExecutor.readSync instead.`,
      );
    }
    if (ambiguousReadOnly === null && !DESTRUCTIVE_GIT_VERBS.has(verb)) {
      audit('git', opts.operation, verb, targets[0], 'denied', 'readonly-verb-via-spawn');
      throw new SafeGitExecutorError(
        `SafeGitExecutor.spawn called with read-only verb '${verb}' — use SafeGitExecutor.readSync instead.`,
      );
    }

    const env = sanitizeEnv(opts.env, opts.cwd);
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      stdio: opts.stdio ?? 'pipe',
      env,
    };
    audit('git', opts.operation, verb, targets[0], 'allowed');
    return nodeSpawn('git', args as string[], spawnOpts);
  }

  /**
   * Read-only escape valve. Runs `git <args>` after verifying:
   *   - Verb is in READONLY_GIT_VERBS (or is an ambiguous verb in read-only shape).
   *   - assertNotInstarSourceTree passes against every target (defense-in-depth
   *     against repo-local aliases that could rebind a "read-only" verb).
   */
  static readSync(args: readonly string[], opts: SafeGitOptions): string {
    const { verb, targets } = extractVerbAndTargets(args, opts.cwd);

    // Verb classification first, BEFORE source-tree check, so callers
    // misusing this method get a clear "use execSync" error rather than
    // a guard error first.
    const verbArgs = sliceAfterVerb(args, verb);
    const ambiguousReadOnly = isReadOnlyShape(verb, verbArgs);
    if (ambiguousReadOnly === false) {
      audit('git', opts.operation, verb, targets[0], 'denied', 'destructive-shape-via-readSync');
      throw new SafeGitExecutorError(
        `SafeGitExecutor.readSync called with destructive shape '${verb} ${verbArgs.join(' ')}' — use SafeGitExecutor.execSync instead.`,
      );
    }
    if (ambiguousReadOnly === null && !READONLY_GIT_VERBS.has(verb)) {
      audit('git', opts.operation, verb, targets[0], 'denied', 'destructive-verb-via-readSync');
      throw new SafeGitExecutorError(
        `SafeGitExecutor.readSync called with destructive verb '${verb}' — use SafeGitExecutor.execSync instead.`,
      );
    }

    // Defense-in-depth: source-tree check on the read path too — UNLESS the
    // caller opted into the narrow read-tier allowlist (the LAYER B/C
    // canonical-ref read path that legitimately operates against the agent's
    // own instar checkout). See SafeGitOptions.sourceTreeReadOk.
    if (!isSourceTreeCheckBypassed(verb, verbArgs, opts)) {
      runSourceTreeChecks(targets, opts.operation, 'git', verb);
    } else {
      audit('git', opts.operation, verb, targets[0], 'allowed', 'sourceTree-bypass');
    }

    const env = sanitizeEnv(opts.env, opts.cwd);
    let stdout: string;
    try {
      stdout = execFileSync('git', args as string[], {
        cwd: opts.cwd,
        stdio: opts.stdio ?? 'pipe',
        encoding: opts.encoding ?? 'utf-8',
        timeout: opts.timeout ?? 30000,
        env,
        input: opts.input,
        maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      }) as string;
    } catch (err) {
      audit('git', opts.operation, verb, targets[0], 'denied', `subprocess-error: ${(err as Error).message}`);
      throw err;
    }
    audit('git', opts.operation, verb, targets[0], 'allowed');
    return stdout || '';
  }

  /**
   * Verb-aware dispatcher. Routes to readSync for known read-only verbs and to
   * execSync otherwise. Use this from generic git() helpers that take dynamic
   * args and don't know at the call site whether the verb is destructive.
   */
  static run(args: readonly string[], opts: SafeGitOptions): string {
    const verb = args[0];
    if (verb && READONLY_GIT_VERBS.has(verb)) {
      const verbArgs = args.slice(1);
      const shape = isReadOnlyShape(verb, verbArgs);
      if (shape !== false) return SafeGitExecutor.readSync(args, opts);
    }
    if (verb && !DESTRUCTIVE_GIT_VERBS.has(verb)) {
      return SafeGitExecutor.readSync(args, opts);
    }
    if (verb) {
      const verbArgs = args.slice(1);
      const shape = isReadOnlyShape(verb, verbArgs);
      if (shape === true) return SafeGitExecutor.readSync(args, opts);
    }
    return SafeGitExecutor.execSync(args, opts);
  }
}

function isSourceTreeCheckBypassed(
  verb: string,
  verbArgs: readonly string[],
  opts: SafeGitOptions,
): boolean {
  if (opts.sourceTreeReadOk && SOURCE_TREE_READ_TIER_VERBS.has(verb)) return true;
  if (opts.sourceTreeWorktreeManagerOk && isSourceTreeWorktreeManagerInvocation(verb, verbArgs)) {
    return true;
  }
  return false;
}

function isSourceTreeWorktreeManagerInvocation(verb: string, verbArgs: readonly string[]): boolean {
  switch (verb) {
    case 'rev-parse':
    case 'check-ref-format':
    case 'symbolic-ref':
    case 'show-ref':
      return true;
    case 'config':
      return isReadOnlyConfigInvocation(verbArgs) || isWorktreeIdentityConfigWrite(verbArgs);
    case 'worktree':
      return isAllowedWorktreeManagerSubcommand(verbArgs);
    default:
      return false;
  }
}

function isWorktreeIdentityConfigWrite(verbArgs: readonly string[]): boolean {
  if (verbArgs.length !== 2) return false;
  return verbArgs[0] === 'user.name' || verbArgs[0] === 'user.email';
}

/**
 * Worktree subcommands the worktree-manager / AgentWorktreeReaper may run against
 * the instar source tree:
 *  - `add` / `prune` — the `instar worktree create` lifecycle (unchanged).
 *  - `list`           — pure read; the reaper enumerates worktrees to evaluate.
 *  - `remove`         — the reaper reclaims a merged+clean+idle worktree, but ONLY
 *                       in its SAFE form. `git worktree remove` without `--force`
 *                       refuses to delete a worktree with uncommitted changes or a
 *                       lock, so it can never destroy in-flight work. `--force`/`-f`
 *                       is explicitly denied here — that is the one form that could.
 */
function isAllowedWorktreeManagerSubcommand(verbArgs: readonly string[]): boolean {
  const subcommand = verbArgs.find((arg) => !arg.startsWith('-'));
  if (subcommand === 'add' || subcommand === 'prune' || subcommand === 'list') return true;
  if (subcommand === 'remove') {
    // Only the non-forced form. --force can delete a dirty worktree (data loss),
    // so it must still trip the source-tree guard. Deny ANY force-ish token shape
    // (`--force`, `--force=1`, `-f`, `-fxyz`) rather than relying on git's own
    // parser to reject lookalikes — the guard stays self-sufficient even if git's
    // argument parsing changes. `worktree remove` has no other `-f`-prefixed flag.
    return !verbArgs.some((arg) => /^--force(=|$)/.test(arg) || /^-f/.test(arg));
  }
  return false;
}

function runSourceTreeChecks(
  targets: readonly string[],
  operation: string,
  executor: 'git' | 'fs',
  verb: string | undefined,
): void {
  for (const t of targets) {
    try {
      assertNotInstarSourceTree(t, operation);
    } catch (err) {
      if (err instanceof SourceTreeGuardError) {
        audit(executor, operation, verb, t, 'denied', err.message);
      }
      throw err;
    }
  }
}

function audit(
  executor: 'git' | 'fs',
  operation: string,
  verb: string | undefined,
  target: string,
  outcome: 'allowed' | 'denied',
  reason?: string,
): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    executor,
    operation,
    target,
    outcome,
    caller: captureCallerFrame(),
  };
  if (verb !== undefined) entry.verb = verb;
  if (reason !== undefined) entry.reason = reason;
  appendAuditEntry(entry);
}

// ── Internal helpers exported for tests only ────────────────────────

/** @internal — exposed for SafeGitExecutor.test.ts */
export const _internal = {
  extractVerbAndTargets,
  isReadOnlyShape,
  sanitizeEnv,
  GIT_ENV_DENYLIST,
  repoHasLocalIdentity,
  _resetLocalIdentityCacheForTest,
};

// Suppress unused-export warnings for the convenience re-exports. The
// test suite imports these symbols.
export { SourceTreeGuardError };
// fileURLToPath import kept available for future use; no current consumers.
void fileURLToPath;
