/**
 * The source-tree guard's runtime-state rule, scoped to the `.instar/` folder of an
 * enclosing instar checkout (docs/specs/guard-runtime-state-scope.md).
 *
 * The legacy shortcut (`isUnderAgentRuntimeState` in SafeFsExecutor) allows any path
 * with `/.instar/` anywhere in it, and every agent home lives at
 * `~/.instar/agents/<name>/`, so on an agent home it allows everything. This module is
 * the replacement policy:
 *
 *   §1  the shortcut holds only for an entry strictly inside `<R>/.instar/` where R is a
 *       CONFIRMED instar checkout, found by a three-way ancestor classifier
 *       (instar / ordinary / indeterminate) that never turns a failed read into an allow;
 *   §2  otherwise any confirmed instar ancestor refuses, only-ordinary ancestors allow,
 *       and an unfinished walk is `indeterminate`;
 *   §3  named scopes, each with its own root predicate and a tracked-file refusal, allow
 *       exactly the callers that relied on the hole.
 *
 * The checked path is always the directory ENTRY the operation modifies: the realpath of
 * its parent plus its own final name. A final symlink is never resolved.
 *
 * Mode (`safety.sourceTreeGuard.runtimeStateScope`): `report` (default) executes the
 * legacy verdict and records differences in a ledger; `enforce` lets this policy decide.
 * `enforce` is never effective while the ledger is marked incomplete.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  classifySourceTreeAncestor,
  SOURCE_TREE_MAX_WALK_LEVELS,
  type SourceTreeAncestorKind,
} from './SourceTreeGuard.js';
import { SafeGitExecutor, isLocalVerifyClonePath } from './SafeGitExecutor.js';

// ── Mode ─────────────────────────────────────────────────────────────

export type RuntimeStateScopeMode = 'report' | 'enforce';

interface ModeState {
  mode: RuntimeStateScopeMode | null;
  stateDir: string | null;
}

const modeState: ModeState = { mode: null, stateDir: null };

/** Normalise a configured value: anything but `enforce` is `report`. */
export function normalizeRuntimeStateScopeMode(raw: unknown): RuntimeStateScopeMode {
  return raw === 'enforce' ? 'enforce' : 'report';
}

/**
 * Called at server boot with the agent's config. A process that never calls it (a CLI
 * command, an out-of-process child) runs in `report`, unless `INSTAR_GUARD_RUNTIME_SCOPE`
 * names the mode.
 */
export function configureGuardRuntimeScope(opts: { mode?: unknown; stateDir?: string | null }): void {
  modeState.mode = opts.mode === undefined ? null : normalizeRuntimeStateScopeMode(opts.mode);
  if (opts.stateDir !== undefined) modeState.stateDir = opts.stateDir ?? null;
}

/** @internal tests */
export function _resetGuardRuntimeScopeForTesting(): void {
  modeState.mode = null;
  modeState.stateDir = null;
  shadowFault = null;
}

/** The configured mode (before the incomplete-observation block). */
export function configuredRuntimeStateScopeMode(): RuntimeStateScopeMode {
  if (modeState.mode) return modeState.mode;
  return normalizeRuntimeStateScopeMode(process.env.INSTAR_GUARD_RUNTIME_SCOPE);
}

/**
 * Where the difference ledger lives (`<agent home>/.instar/state`), or null when no agent
 * home can be resolved — then nothing is written, and no folder is ever created in an
 * arbitrary working directory. In order:
 *   1. `INSTAR_GUARD_SCOPE_LEDGER_DIR` (tests);
 *   2. the stateDir the server configured at boot;
 *   3. `INSTAR_AGENT_HOME`, when `<home>/.instar` is an existing folder (set by the agent
 *      launcher for sessions, hooks and the CLI);
 *   4. the working directory, only when it is itself an agent home (`<cwd>/.instar/config.json`
 *      exists): the out-of-process children (the worktree reclaim child refuses to run unless
 *      its cwd is the agent home) are covered this way.
 */
export function guardScopeStateDir(): string | null {
  const override = process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR;
  if (override) return override;
  if (modeState.stateDir) return path.join(modeState.stateDir, 'state');
  const isRealDir = (p: string): boolean => {
    try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); }
    catch { return false; } // @silent-fallback-ok — absent or unreadable: not an agent home
  };
  const envHome = process.env.INSTAR_AGENT_HOME;
  if (envHome && path.isAbsolute(envHome) && isRealDir(path.join(envHome, '.instar'))) return path.join(envHome, '.instar', 'state');
  let cwd: string;
  try { cwd = process.cwd(); } catch { return null; } // @silent-fallback-ok — no cwd: no agent home
  try {
    if (isRealDir(path.join(cwd, '.instar')) && fs.lstatSync(path.join(cwd, '.instar', 'config.json')).isFile()) return path.join(cwd, '.instar', 'state');
  } catch { /* @silent-fallback-ok — the cwd is not an agent home */ }
  return null;
}

// Test seam: an injected shadow fault (throw or slow path).
let shadowFault: (() => void) | null = null;
/** @internal tests: make the next shadow evaluations call `fn` first (it may throw). */
export function _setShadowFaultForTesting(fn: (() => void) | null): void { shadowFault = fn; }
/** @internal */
export function _runShadowFault(): void { if (shadowFault) shadowFault(); }

// ── Request ──────────────────────────────────────────────────────────

export type GuardVerb = 'rm' | 'unlink' | 'rmdir';

/** `feedbackCanaryScope` — the confinement canary's fixtures (§3). */
export interface FeedbackCanaryScope { worktreesDir: string }
/** `gitRebaseStateScope` — GitSync's stuck-rebase cleanup (§3). */
export interface GitRebaseStateScope { projectDir: string }
/** `learnedSkillScope` — skill-learning's rendering folders (§3). */
export interface LearnedSkillScope { projectDir: string }
/** `nodeModulesCloneStagingScope` — the worktree node_modules clone staging folder (§3). */
export interface NodeModulesCloneStagingScope { worktreeRoot: string }

export interface RuntimeScopeOptions {
  localVerifyScopeOk?: { verifyRoot: string };
  feedbackCanaryScope?: FeedbackCanaryScope;
  gitRebaseStateScope?: GitRebaseStateScope;
  learnedSkillScope?: LearnedSkillScope;
  nodeModulesCloneStagingScope?: NodeModulesCloneStagingScope;
}

export interface GuardRequest {
  target: string;
  verb: GuardVerb;
  recursive: boolean;
  force: boolean;
  scopes: RuntimeScopeOptions;
}

export type PolicyReason =
  | 'raw-component'
  | 'inside-source'
  | 'indeterminate'
  | 'ordinary'
  | 'runtime-state'
  | 'scope-refused';

export interface PolicyVerdict {
  allow: boolean;
  reason: PolicyReason;
  /** `scope:<name>` when a named scope decided. */
  scope?: string;
  /** The canonical entry (parent realpath + final name), when it could be computed. */
  entry: string | null;
  detail?: string;
  /** Whether a scope ran `git ls-files` and what it said. */
  tracked?: TrackedState;
}

// ── Raw components and the entry ─────────────────────────────────────

/**
 * Reject `..`, an empty name and NUL before any normalisation. The leading empty
 * component of an absolute path is not a name.
 */
export function rawComponentProblem(target: string): string | null {
  if (typeof target !== 'string' || target.length === 0) return 'empty path';
  if (target.includes('\0')) return 'NUL in path';
  const parts = target.split(/[\\/]/);
  const start = parts[0] === '' ? 1 : 0;
  for (let i = start; i < parts.length; i++) {
    const p = parts[i];
    if (p === '') return 'empty path component';
    if (p === '..') return "'..' component";
  }
  const last = parts[parts.length - 1];
  if (last === '.') return "final name '.'";
  return null;
}

function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The entry an operation modifies: realpath of the nearest existing ancestor of the
 * parent, plus the remaining components, plus the final name. Never resolves the final
 * name. Throws when no ancestor can be canonicalised.
 */
export function canonicalEntryPath(target: string): string {
  const resolved = path.resolve(target);
  const name = path.basename(resolved);
  let parent = path.dirname(resolved);
  const tail: string[] = [];
  for (let i = 0; i <= SOURCE_TREE_MAX_WALK_LEVELS; i++) {
    try {
      const real = fs.realpathSync(parent);
      return path.join(real, ...tail.reverse(), name);
    } catch (err) {
      if (!isAbsent(err)) throw err;
    }
    const up = path.dirname(parent);
    if (up === parent) break;
    tail.push(path.basename(parent));
    parent = up;
  }
  throw new Error(`no existing ancestor of ${target} could be canonicalised`);
}

// ── The ancestor walk ────────────────────────────────────────────────

export interface WalkedAncestor {
  dir: string;
  kind: SourceTreeAncestorKind;
  /** `<dir>/.git` exists (folder or pointer file). */
  hasGit: boolean;
  /** True for the entry itself (only when it is a real folder). */
  self: boolean;
  errors: string[];
}

export interface AncestorWalk {
  entry: string;
  /** Nearest first: the entry itself (if a real folder), then its parent, … up to `/`. */
  ancestors: WalkedAncestor[];
  /** The walk stopped early (cap reached or an ancestor could not be read). */
  incomplete: boolean;
  incompleteReason?: string;
}

/** Classify the entry's ancestors (and the entry itself when it is a real directory). */
export function walkEntryAncestors(entry: string, memo?: Map<string, WalkedAncestor>): AncestorWalk {
  const ancestors: WalkedAncestor[] = [];
  const classify = (dir: string, self: boolean): WalkedAncestor => {
    const cached = memo?.get(dir);
    if (cached) return { ...cached, self };
    const { kind, evidence } = classifySourceTreeAncestor(dir);
    const a: WalkedAncestor = { dir, kind, hasGit: evidence.dotGit === 'dir' || evidence.dotGit === 'file', self, errors: evidence.errors };
    memo?.set(dir, a);
    return a;
  };
  let entryIsRealDir = false;
  try { const st = fs.lstatSync(entry); entryIsRealDir = st.isDirectory() && !st.isSymbolicLink(); }
  catch (err) {
    if (!isAbsent(err)) return { entry, ancestors, incomplete: true, incompleteReason: `entry unreadable: ${(err as NodeJS.ErrnoException).code ?? 'error'}` };
  }
  if (entryIsRealDir) ancestors.push(classify(entry, true));
  // The parent chain. Components below the nearest existing ancestor do not exist yet and
  // carry no evidence, so the walk starts at the first existing folder.
  let dir = path.dirname(entry);
  for (let i = 0; i < SOURCE_TREE_MAX_WALK_LEVELS; i++) {
    let exists = true;
    try { fs.lstatSync(dir); } catch (err) {
      if (isAbsent(err)) exists = false;
      else return { entry, ancestors, incomplete: true, incompleteReason: `ancestor unreadable: ${dir}` };
    }
    if (exists) ancestors.push(classify(dir, false));
    const up = path.dirname(dir);
    if (up === dir) return { entry, ancestors, incomplete: false };
    dir = up;
  }
  return { entry, ancestors, incomplete: true, incompleteReason: `walk cap of ${SOURCE_TREE_MAX_WALK_LEVELS} levels reached` };
}

function strictlyInside(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep) && child.length > parent.length + 1;
}

/** §1: the entry is strictly inside `<R>/.instar/` for a confirmed instar ancestor R. */
export function insideInstarRuntimeState(walk: AncestorWalk): string | null {
  for (const a of walk.ancestors) {
    if (a.self || a.kind !== 'instar') continue;
    if (strictlyInside(walk.entry, path.join(a.dir, '.instar'))) return a.dir;
  }
  return null;
}

// ── Tracked-file check ───────────────────────────────────────────────

export type TrackedState = 'tracked' | 'untracked' | 'indeterminate';

export type LsFilesRunner = (checkoutRoot: string, target: string) => TrackedState;

export const LS_FILES_TIMEOUT_MS = 3_000;

/**
 * `git -C <root> ls-files --error-unmatch -- <target>` through SafeGitExecutor's read path.
 * Exit 0 = tracked, exit 1 = untracked, anything else (or a timeout) = indeterminate.
 */
export const defaultLsFiles: LsFilesRunner = (checkoutRoot, target) => {
  try {
    SafeGitExecutor.readSync(['-C', checkoutRoot, 'ls-files', '--error-unmatch', '--', target], {
      operation: 'src/core/guardRuntimeScope.ts:tracked-check',
      sourceTreeReadOk: true,
      timeout: LS_FILES_TIMEOUT_MS,
      stdio: 'pipe',
    });
    return 'tracked';
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null };
    if (e && e.status === 1 && !e.signal) return 'untracked';
    return 'indeterminate';
  }
};

let lsFilesRunner: LsFilesRunner = defaultLsFiles;
/** @internal tests */
export function _setLsFilesRunnerForTesting(fn: LsFilesRunner | null): void { lsFilesRunner = fn ?? defaultLsFiles; }
/** Count of ls-files invocations (tests assert it never runs off a scope shape). */
export const lsFilesCounter = { count: 0 };

function trackedState(walk: AncestorWalk): TrackedState {
  // The enclosing checkout is the nearest ancestor (not the entry itself) with git metadata.
  const root = walk.ancestors.find((a) => !a.self && a.hasGit);
  if (!root) return 'indeterminate';
  lsFilesCounter.count++;
  return lsFilesRunner(root.dir, walk.entry);
}

// ── Scope root predicates ────────────────────────────────────────────

function realOrNull(p: string): string | null {
  try { return fs.realpathSync(path.resolve(p)); } catch { return null; } // @silent-fallback-ok — an unresolvable scope root qualifies nothing
}

function isConfirmedInstarRoot(dir: string, memo: Map<string, WalkedAncestor>): boolean {
  const cached = memo.get(dir);
  if (cached) return cached.kind === 'instar';
  return classifySourceTreeAncestor(dir).kind === 'instar';
}

/** A worktree root listed in the worktree metadata of a confirmed instar checkout (or that checkout itself). */
function isListedInstarWorktree(worktreeReal: string, memo: Map<string, WalkedAncestor>): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(path.join(worktreeReal, '.git')); } catch { return false; } // @silent-fallback-ok — no git metadata: not a worktree
  if (st.isDirectory()) return isConfirmedInstarRoot(worktreeReal, memo); // the main worktree
  let gitdir: string;
  try {
    const m = fs.readFileSync(path.join(worktreeReal, '.git'), 'utf8').match(/^\s*gitdir:\s*(.+?)\s*$/m);
    if (!m) return false;
    gitdir = fs.realpathSync(path.isAbsolute(m[1]) ? m[1] : path.resolve(worktreeReal, m[1]));
  } catch { return false; } // @silent-fallback-ok — an unreadable pointer lists nothing
  if (path.basename(path.dirname(gitdir)) !== 'worktrees') return false;
  const commonDir = path.dirname(path.dirname(gitdir));
  if (path.basename(commonDir) !== '.git') return false;
  const root = path.dirname(commonDir);
  if (!isConfirmedInstarRoot(root, memo)) return false;
  // The listing evidence `git worktree list` itself reads: <common>/worktrees/<name>/gitdir names <worktree>/.git.
  try {
    const listed = fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim();
    const listedRoot = fs.realpathSync(path.dirname(path.isAbsolute(listed) ? listed : path.resolve(gitdir, listed)));
    return listedRoot === worktreeReal;
  } catch { return false; } // @silent-fallback-ok — not listed
}

const NONCE = '[A-Za-z0-9]+';
const CANARY_SIB_RE = new RegExp(`^\\.feedback-canary-sib-(${NONCE})$`);
const CANARY_LEFTOVER_RE = new RegExp(`^\\.feedback-canary-(?:hl|link|siblink)-${NONCE}$`);
const FEEDBACK_WORKSPACE_RE = /^feedback-[a-z0-9-]+-a\d+$/;
const NODE_MODULES_STAGING_RE = /^node_modules\.clone-\d+-\d+$/;

interface ScopeMatch { scope: string; ok: boolean; detail: string; trackedCheck: boolean }

/**
 * Each scope: if the entry has the scope's SHAPE relative to the scope's realpath'd
 * root, the scope decides (allow, or refuse with a reason); otherwise it does not apply.
 */
function matchScopes(req: GuardRequest, entry: string, memo: Map<string, WalkedAncestor>): ScopeMatch | null {
  const parent = path.dirname(entry);
  const name = path.basename(entry);
  const s = req.scopes;

  if (s.localVerifyScopeOk && isLocalVerifyClonePath(entry, s.localVerifyScopeOk.verifyRoot)) {
    return { scope: 'localVerifyScopeOk', ok: true, detail: 'local-verify clone path', trackedCheck: false };
  }

  if (s.feedbackCanaryScope) {
    const wt = realOrNull(s.feedbackCanaryScope.worktreesDir);
    if (wt) {
      const grand = path.dirname(parent);
      const sibFolder = parent === wt && CANARY_SIB_RE.test(name);
      const sibMatch = grand === wt ? path.basename(parent).match(CANARY_SIB_RE) : null;
      const sibFile = !!sibMatch && (name === `sib-${sibMatch[1]}.txt` || name === 'w.txt');
      const leftover = grand === wt && FEEDBACK_WORKSPACE_RE.test(path.basename(parent)) && CANARY_LEFTOVER_RE.test(name);
      if (sibFolder || sibFile || leftover) {
        const rootOk = path.basename(wt) === '.worktrees' && isConfirmedInstarRoot(path.dirname(wt), memo);
        if (!rootOk) return { scope: 'feedbackCanaryScope', ok: false, detail: 'worktreesDir is not <instar checkout>/.worktrees', trackedCheck: false };
        if (sibFolder) {
          const verbOk = req.verb === 'rmdir' && !req.recursive;
          return { scope: 'feedbackCanaryScope', ok: verbOk, detail: verbOk ? 'canary sibling folder' : 'canary sibling folder allows only a non-recursive rmdir', trackedCheck: verbOk };
        }
        const verbOk = req.verb === 'unlink';
        return { scope: 'feedbackCanaryScope', ok: verbOk, detail: verbOk ? (sibFile ? 'canary sibling file' : 'canary workspace leftover') : 'canary files allow only unlink', trackedCheck: verbOk };
      }
    }
  }

  if (s.gitRebaseStateScope) {
    const root = realOrNull(s.gitRebaseStateScope.projectDir);
    if (root && (entry === path.join(root, '.git', 'rebase-merge') || entry === path.join(root, '.git', 'rebase-apply'))) {
      if (!isConfirmedInstarRoot(root, memo)) return { scope: 'gitRebaseStateScope', ok: false, detail: 'projectDir is not a confirmed instar checkout root', trackedCheck: false };
      const verbOk = req.verb === 'rm' && req.recursive;
      return { scope: 'gitRebaseStateScope', ok: verbOk, detail: verbOk ? 'rebase state folder' : 'rebase state allows only a recursive rm', trackedCheck: false };
    }
  }

  if (s.learnedSkillScope) {
    const root = realOrNull(s.learnedSkillScope.projectDir);
    if (root && (parent === path.join(root, '.claude', 'skills') || parent === path.join(root, '.agents', 'skills'))) {
      if (!isConfirmedInstarRoot(root, memo)) return { scope: 'learnedSkillScope', ok: false, detail: 'projectDir is not a confirmed instar checkout root', trackedCheck: false };
      const verbOk = req.verb === 'rm' && req.recursive;
      return { scope: 'learnedSkillScope', ok: verbOk, detail: verbOk ? 'learned skill folder' : 'learned skill folders allow only a recursive rm', trackedCheck: verbOk };
    }
  }

  if (s.nodeModulesCloneStagingScope) {
    const root = realOrNull(s.nodeModulesCloneStagingScope.worktreeRoot);
    if (root && parent === root && NODE_MODULES_STAGING_RE.test(name)) {
      if (!isListedInstarWorktree(root, memo)) return { scope: 'nodeModulesCloneStagingScope', ok: false, detail: 'worktreeRoot is not a listed worktree of a confirmed instar checkout', trackedCheck: false };
      const verbOk = req.verb === 'rm' && req.recursive && req.force;
      return { scope: 'nodeModulesCloneStagingScope', ok: verbOk, detail: verbOk ? 'node_modules clone staging folder' : 'staging allows only a recursive, forced rm', trackedCheck: verbOk };
    }
  }

  return null;
}

// ── The policy ───────────────────────────────────────────────────────

/**
 * The new policy's verdict for one request. Pure with respect to the mode: it is what
 * `enforce` executes and what `report` records. Never throws for a refusal; it may throw
 * on an unexpected internal error (callers fence it).
 */
export function evaluateRuntimeScopePolicy(req: GuardRequest): PolicyVerdict {
  const raw = rawComponentProblem(req.target);
  if (raw) return { allow: false, reason: 'raw-component', entry: null, detail: raw };
  let entry: string;
  try { entry = canonicalEntryPath(req.target); }
  catch (err) { return { allow: false, reason: 'indeterminate', entry: null, detail: `the entry could not be canonicalised: ${(err as Error).message}` }; }

  const memo = new Map<string, WalkedAncestor>();
  const walk = walkEntryAncestors(entry, memo);

  // §3: named scopes first.
  const scope = matchScopes(req, entry, memo);
  if (scope) {
    if (!scope.ok) return { allow: false, reason: 'scope-refused', scope: `scope:${scope.scope}`, entry, detail: scope.detail };
    if (scope.trackedCheck) {
      const tracked = trackedState(walk);
      if (tracked === 'tracked') return { allow: false, reason: 'scope-refused', scope: `scope:${scope.scope}`, entry, detail: 'target is tracked by git', tracked };
      if (tracked === 'indeterminate') return { allow: false, reason: 'scope-refused', scope: `scope:${scope.scope}`, entry, detail: 'git could not say whether the target is tracked', tracked };
      return { allow: true, reason: 'ordinary', scope: `scope:${scope.scope}`, entry, detail: scope.detail, tracked };
    }
    return { allow: true, reason: 'ordinary', scope: `scope:${scope.scope}`, entry, detail: scope.detail };
  }

  // §1: the shortcut.
  const runtimeRoot = insideInstarRuntimeState(walk);
  if (runtimeRoot) return { allow: true, reason: 'runtime-state', entry, detail: `inside ${path.join(runtimeRoot, '.instar')}` };

  // §2: the protection check over every enclosing checkout.
  const source = walk.ancestors.find((a) => a.kind === 'instar');
  if (source) return { allow: false, reason: 'inside-source', entry, detail: source.self ? `the entry is an instar checkout (${source.dir})` : `inside instar checkout ${source.dir}` };
  if (walk.incomplete) return { allow: false, reason: 'indeterminate', entry, detail: walk.incompleteReason };
  const unknown = walk.ancestors.find((a) => a.kind === 'indeterminate');
  if (unknown) return { allow: false, reason: 'indeterminate', entry, detail: `${unknown.dir}: ${unknown.errors.join('; ')}` };
  return { allow: true, reason: 'ordinary', entry };
}

/** Whether the entry is a confirmed instar checkout root itself (the ledger's `checkout-root` class). */
export function entryIsInstarCheckoutRoot(entry: string): boolean {
  try {
    const st = fs.lstatSync(entry);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
  } catch { return false; } // @silent-fallback-ok — absent or unreadable is not a checkout root
  return classifySourceTreeAncestor(entry).kind === 'instar';
}

/** For the ledger's `source-file` class: is the entry tracked in its enclosing checkout? */
export function entryTrackedState(entry: string): TrackedState {
  return trackedState(walkEntryAncestors(entry));
}
