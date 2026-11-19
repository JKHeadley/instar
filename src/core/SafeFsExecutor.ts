// safe-git-allow: this file is the single funnel point for destructive fs invocations.
/**
 * SafeFsExecutor — the single funnel for destructive filesystem invocations.
 *
 * Parallel structure to SafeGitExecutor. Wraps `fs.rm`, `fs.rmSync`,
 * `fs.unlink`, `fs.unlinkSync`, `fs.rmdir`, `fs.rmdirSync` (and their
 * promises-API counterparts). Each wrapper:
 *
 *   1. Canonicalizes `target` via `realpathSync` (or nearest-existing-ancestor
 *      if the target itself doesn't exist — `assertNotInstarSourceTree`
 *      handles this internally).
 *   2. Calls `assertNotInstarSourceTree(target, operation)`. On failure,
 *      throws SourceTreeGuardError BEFORE touching disk.
 *   3. Performs the actual fs operation.
 *   4. Appends a JSON line to .instar/audit/destructive-ops.jsonl.
 *
 * See docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md.
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  assertNotInstarSourceTree,
  SourceTreeGuardError,
} from './SourceTreeGuard.js';
import { appendAuditEntry, isLocalVerifyClonePath } from './SafeGitExecutor.js';
import {
  configuredRuntimeStateScopeMode,
  entryIsInstarCheckoutRoot,
  entryTrackedState,
  evaluateRuntimeScopePolicy,
  _runShadowFault,
  type FeedbackCanaryScope,
  type GitRebaseStateScope,
  type GuardRequest,
  type GuardVerb,
  type LearnedSkillScope,
  type NodeModulesCloneStagingScope,
  type PolicyVerdict,
  type RuntimeScopeOptions,
} from './guardRuntimeScope.js';
import { isObservationIncomplete, recordDiff, type TargetClass } from './guardScopeLedger.js';

export interface SafeFsOptions {
  /** Caller label for error messages and audit log. */
  operation: string;
  /**
   * Opt-in: local-verify's own clone and run directories (docs/specs/local-verify-merge-authority.md
   * §2). Admits a target only when its realpath is THIS agent's `verifyRoot`
   * (`<agentHome>/.worktrees/.verify`, realpath'd) or below it — the run worktrees are copies of the
   * instar source, which the guard would otherwise refuse. Never widens anything else.
   */
  localVerifyScopeOk?: { verifyRoot: string };
  /**
   * Opt-in: the agent worktree reaper's trash (docs/specs/reaper-removal-out-of-process.md §2).
   * When given it is checked FIRST and decides alone — allowed only if the target
   * qualifies, refused otherwise, never falling through to a broader rule such as
   * the `.instar/` runtime-state carve-out. On a delete (and a rename destination)
   * the target must be strictly inside the realpath of `trashRoot`, which must not
   * be a symlink. A rename source is checked by `safeRenameDirSync` only.
   */
  worktreeTrashScope?: WorktreeTrashScope;
  /**
   * Named scopes of the runtime-state rule (docs/specs/guard-runtime-state-scope.md §3).
   * Each allows exactly its caller's targets, by shape, under its own root predicate, and
   * refuses a git-tracked target. In `report` mode they shape only the recorded shadow
   * verdict; in `enforce` they decide.
   */
  /** The feedback executor's confinement canary fixtures. */
  feedbackCanaryScope?: FeedbackCanaryScope;
  /** GitSync's `.git/rebase-merge` / `.git/rebase-apply` cleanup. */
  gitRebaseStateScope?: GitRebaseStateScope;
  /** Skill learning's rendering folders under `.claude/skills/` and `.agents/skills/`. */
  learnedSkillScope?: LearnedSkillScope;
  /** The worktree `node_modules.clone-<pid>-<ms>` staging folder. */
  nodeModulesCloneStagingScope?: NodeModulesCloneStagingScope;
}

/** The narrow allowance the out-of-process worktree reclaim uses (spec reaper-removal-out-of-process §2). */
export interface WorktreeTrashScope {
  /** The agent's `.worktrees/` folder. */
  worktreesDir: string;
  /** `<worktreesDir>/.trash`: a real folder directly inside `worktreesDir`. */
  trashRoot: string;
  /** Rename sources this run's evaluation passed. A source not listed is refused. */
  allowedSources?: readonly string[];
}

/** Thrown when a `worktreeTrashScope` call does not qualify. Nothing was touched. */
export class WorktreeTrashScopeError extends Error {
  readonly code = 'INSTAR_WORKTREE_TRASH_SCOPE';
  constructor(readonly target: string, readonly operation: string, readonly reason: string) {
    super(`Refusing ${operation} on ${target}: ${reason}`);
    this.name = 'WorktreeTrashScopeError';
  }
}

export type WorktreeTrashRole = 'rename-source' | 'trash';

/**
 * Canonical form of a path that may not exist yet: the realpath of its parent
 * folder plus its last name. A last name of `.` or `..` (or none) is refused,
 * so the result always names a child of a real folder. A symlinked component in
 * the parent's path resolves rather than refusing. Throws when the parent does
 * not exist.
 */
export function canonicalizeLeafPath(target: string): string {
  const raw = target.replace(/[\\/]+$/, '');
  const last = raw.split(/[\\/]/).pop() ?? '';
  if (last === '' || last === '.' || last === '..') throw new Error(`no usable last name in ${target}`);
  const resolved = path.resolve(raw);
  return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
}

/**
 * The `worktreeTrashScope` decision, exported for tests. Returns the canonical
 * target when it qualifies for `role`, else the refusal reason.
 */
export function decideWorktreeTrashScope(
  target: string,
  scope: WorktreeTrashScope,
  role: WorktreeTrashRole,
): { ok: true; canonical: string } | { ok: false; reason: string } {
  let worktreesReal: string;
  let trashReal: string;
  try {
    worktreesReal = fs.realpathSync(path.resolve(scope.worktreesDir));
    const trashStat = fs.lstatSync(path.resolve(scope.trashRoot));
    if (trashStat.isSymbolicLink()) return { ok: false, reason: 'the trash root is a symlink' };
    if (!trashStat.isDirectory()) return { ok: false, reason: 'the trash root is not a folder' };
    trashReal = fs.realpathSync(path.resolve(scope.trashRoot));
  } catch (err) {
    return { ok: false, reason: `the trash root or worktrees folder cannot be resolved: ${(err as Error).message}` };
  }
  if (path.dirname(trashReal) !== worktreesReal) return { ok: false, reason: 'the trash root is not directly inside the worktrees folder' };
  let canonical: string;
  try { canonical = canonicalizeLeafPath(target); }
  catch (err) { return { ok: false, reason: `target cannot be canonicalized: ${(err as Error).message}` }; }
  if (role === 'trash') {
    if (!canonical.startsWith(trashReal + path.sep) || canonical.length <= trashReal.length + 1) {
      return { ok: false, reason: 'target is not strictly inside the trash root' };
    }
    return { ok: true, canonical };
  }
  // rename-source
  if (path.dirname(canonical) !== worktreesReal) return { ok: false, reason: 'rename source is not a direct child of the worktrees folder' };
  if (canonical === trashReal) return { ok: false, reason: 'rename source is the trash root' };
  let st: fs.Stats;
  try { st = fs.lstatSync(canonical); }
  catch (err) { return { ok: false, reason: `rename source cannot be read: ${(err as Error).message}` }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: 'rename source is not a real folder' };
  const allowed = new Set<string>();
  for (const a of scope.allowedSources ?? []) {
    try { allowed.add(canonicalizeLeafPath(a)); } catch { /* @silent-fallback-ok — an unresolvable allowed source allows nothing */ }
  }
  if (!allowed.has(canonical)) return { ok: false, reason: 'rename source did not pass this run\'s evaluation' };
  return { ok: true, canonical };
}

export type SafeRmOptions = fs.RmOptions & SafeFsOptions;
export type SafeRmDirOptions = fs.RmDirOptions & SafeFsOptions;

function captureCallerFrame(): string {
  const e = new Error();
  const stack = (e.stack || '').split('\n');
  return (stack[3] || stack[2] || '').trim();
}

function audit(
  fnName: string,
  operation: string,
  target: string,
  outcome: 'allowed' | 'denied',
  reason?: string,
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    executor: 'fs',
    operation,
    verb: fnName,
    target,
    outcome,
    caller: captureCallerFrame(),
  };
  if (reason !== undefined) entry.reason = reason;
  appendAuditEntry(entry as never);
}

function canonicalizeTarget(target: string): string {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

/**
 * Agent runtime state carve-out.
 *
 * When instar is deployed in "agent" mode the agent dir IS a checkout of the
 * instar source (same .git, same .instar-source-tree marker, same package.json
 * with name === "instar"). The guard correctly identifies this as the source
 * tree — but runtime artifacts under `.instar/` (sockets, locks, logs, audit
 * trail) are explicitly NOT source code (they are .gitignored). Destructive
 * ops on those paths are a normal part of operation, not a 2026-04-22-class
 * incident.
 *
 * This predicate returns true when `canonical` is anywhere under an `.instar/`
 * subdirectory of the source root — those are runtime state and the guard's
 * brittle-block is a false positive for them.
 *
 * The check is intentionally narrow: it requires `/.instar/` as an interior
 * path segment (not just trailing), so operations on the `.instar` directory
 * itself still go through the guard. The carve-out is for files INSIDE it.
 */
function isUnderAgentRuntimeState(canonical: string): boolean {
  const sep = path.sep;
  const marker = `${sep}.instar${sep}`;
  const idx = canonical.indexOf(marker);
  if (idx === -1) return false;
  return canonical.length > idx + marker.length;
}

/** What a wrapper is about to do, for the runtime-state policy (spec guard-runtime-state-scope). */
interface GuardOp {
  verb: GuardVerb;
  recursive: boolean;
  force: boolean;
  scopes: RuntimeScopeOptions;
}

function scopesOf(opts: SafeFsOptions): RuntimeScopeOptions {
  return {
    localVerifyScopeOk: opts.localVerifyScopeOk,
    feedbackCanaryScope: opts.feedbackCanaryScope,
    gitRebaseStateScope: opts.gitRebaseStateScope,
    learnedSkillScope: opts.learnedSkillScope,
    nodeModulesCloneStagingScope: opts.nodeModulesCloneStagingScope,
  };
}

/** Thrown in `enforce` when the runtime-state policy refuses. A SourceTreeGuardError, so existing catches still match. */
export class RuntimeScopeRefusalError extends SourceTreeGuardError {
  readonly policyReason: string;
  constructor(target: string, entry: string | null, operation: string, verdict: PolicyVerdict) {
    super(target, entry ?? target, operation);
    this.policyReason = verdict.scope ? `${verdict.scope}: ${verdict.detail ?? verdict.reason}` : `${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''}`;
    this.message = `Refusing ${operation} on ${target}: ${this.policyReason} (source-tree guard, runtime-state scope enforce)`;
  }
}

const EXECUTOR_FRAME = /SafeFsExecutor\.[jt]s|guardRuntimeScope\.[jt]s|guardScopeLedger\.[jt]s/;

/** The first stack frame outside this executor: the code that asked for the delete. */
function callerOutsideExecutor(): string {
  const lines = (new Error().stack || '').split('\n').slice(1);
  for (const l of lines) if (!EXECUTOR_FRAME.test(l)) return l.trim();
  return (lines[lines.length - 1] || '').trim();
}

/** The legacy verdict, exactly as before this change (audits included). Returns the error instead of throwing it. */
function legacyVerdict(target: string, operation: string, fnName: string, localVerifyScopeOk?: { verifyRoot: string }): { canonical: string; error?: unknown } {
  const canonical = canonicalizeTarget(target);
  if (localVerifyScopeOk && isLocalVerifyClonePath(canonical, localVerifyScopeOk.verifyRoot)) {
    audit(fnName, operation, canonical, 'allowed', 'local-verify-scope-carveout');
    return { canonical };
  }
  // Carve-out: runtime state under `.instar/` is gitignored, not source code.
  // The guard's brittle-block is a false positive for these paths in
  // agent-mode deployments where the agent dir IS a checkout of the source.
  // See isUnderAgentRuntimeState() above for the precise predicate.
  if (isUnderAgentRuntimeState(canonical)) {
    audit(fnName, operation, canonical, 'allowed', 'agent-runtime-state-carveout');
    return { canonical };
  }
  try {
    assertNotInstarSourceTree(canonical, operation);
  } catch (err) {
    if (err instanceof SourceTreeGuardError) {
      audit(fnName, operation, canonical, 'denied', err.message);
    }
    return { canonical, error: err };
  }
  return { canonical };
}

const NUKE_OPERATION = /^src\/commands\/nuke\.ts/;

/**
 * `report` mode's shadow: evaluate the new policy on the original request and record a
 * difference in either direction. Fenced: it never throws and never changes the
 * executed verdict; any failure is recorded as a `shadow-error` would-deny row.
 */
function shadowEvaluate(req: GuardRequest, operation: string, legacyAllowed: boolean, caller: string): void {
  try {
    _runShadowFault();
    const v = evaluateRuntimeScopePolicy(req);
    if (v.allow === legacyAllowed) return;
    const direction = legacyAllowed ? 'would-deny' : 'would-allow';
    // Classified lazily: recordDiff calls this only for a difference not yet written today,
    // so a repeat never pays the checkout check or the `git ls-files` spawn.
    const entry = v.entry;
    const targetClass = (): TargetClass => {
      if (direction !== 'would-deny' || !entry) return 'other';
      if (entryIsInstarCheckoutRoot(entry)) return 'checkout-root';
      if (v.reason === 'inside-source' && entryTrackedState(entry) === 'tracked') return 'source-file';
      return 'other';
    };
    recordDiff({
      direction, verb: req.verb, recursive: req.recursive,
      reason: v.scope ? `${v.reason}:${v.scope}` : v.reason,
      caller, operation, samplePath: v.entry ?? path.resolve(req.target), targetClass,
      ...(direction === 'would-deny' && NUKE_OPERATION.test(operation) ? { presetDisposition: { disposition: 'needs-scope' as const, note: 'spec B (nuke teardown)' } } : {}),
      ...(v.detail ? { detail: String(v.detail).slice(0, 300) } : {}),
    });
  } catch (err) {
    try {
      recordDiff({
        direction: 'would-deny', verb: req.verb, recursive: req.recursive, reason: 'shadow-error',
        caller, operation, samplePath: path.resolve(String(req.target)), targetClass: 'other',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    } catch { /* @silent-fallback-ok — the ledger cannot be written at all; the shadow must never block the executed verdict */ }
  }
}

/**
 * The mode the guard executes: `enforce` only when configured AND the observation is
 * provably complete. Fail-safe: a marker that cannot be checked, a marker of any kind, or
 * no resolvable ledger home counts as incomplete (see isObservationIncomplete), so
 * `enforce` stays blocked and today's verdict runs.
 */
function effectiveScopeMode(): 'report' | 'enforce' {
  if (configuredRuntimeStateScopeMode() !== 'enforce') return 'report';
  try { return isObservationIncomplete() ? 'report' : 'enforce'; }
  catch { return 'report'; } // @silent-fallback-ok — an unexpected error counts as incomplete: enforce stays blocked
}

function guard(
  target: string,
  operation: string,
  fnName: string,
  op: GuardOp | null,
  trash?: { scope: WorktreeTrashScope; role: WorktreeTrashRole },
): string {
  // The worktree trash scope comes FIRST and decides alone: it must never fall
  // through to the `.instar/` runtime-state carve-out below, which allows any
  // path containing `/.instar/` (every agent home lives under one).
  if (trash) {
    const verdict = decideWorktreeTrashScope(target, trash.scope, trash.role);
    if (verdict.ok) {
      audit(fnName, operation, verdict.canonical, 'allowed', `worktree-trash-scope:${trash.role}`);
      return verdict.canonical;
    }
    audit(fnName, operation, path.resolve(target), 'denied', `worktree-trash-scope:${trash.role}: ${verdict.reason}`);
    throw new WorktreeTrashScopeError(target, operation, verdict.reason);
  }
  const scopes = op?.scopes ?? {};
  const req: GuardRequest = { target, verb: op?.verb ?? 'rm', recursive: op?.recursive ?? false, force: op?.force ?? false, scopes };

  if (effectiveScopeMode() === 'enforce') {
    let v: PolicyVerdict;
    try { v = evaluateRuntimeScopePolicy(req); }
    catch (err) { v = { allow: false, reason: 'indeterminate', entry: null, detail: `policy error: ${(err as Error).message}` }; }
    const shown = v.entry ?? path.resolve(target);
    const label = `runtime-state-scope:${v.scope ?? v.reason}`;
    if (v.allow) {
      audit(fnName, operation, shown, 'allowed', label);
      return shown;
    }
    const refusal = new RuntimeScopeRefusalError(target, v.entry, operation, v);
    audit(fnName, operation, shown, 'denied', `${label}: ${refusal.policyReason}`);
    throw refusal;
  }

  // report: the legacy verdict is the one executed; the new policy is only recorded.
  const legacy = legacyVerdict(target, operation, fnName, scopes.localVerifyScopeOk);
  shadowEvaluate(req, operation, legacy.error === undefined, callerOutsideExecutor());
  if (legacy.error !== undefined) throw legacy.error;
  return legacy.canonical;
}

function rmOp(opts: SafeRmOptions): GuardOp {
  return { verb: 'rm', recursive: !!opts.recursive, force: !!opts.force, scopes: scopesOf(opts) };
}

function trashOf(scope: WorktreeTrashScope | undefined): { scope: WorktreeTrashScope; role: WorktreeTrashRole } | undefined {
  return scope ? { scope, role: 'trash' } : undefined;
}

/** Outcome of `safeRmTreeInSubprocess`. */
export interface SubprocessRmResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error?: string;
}

// ── Public API ──────────────────────────────────────────────────────

/** Depth-first removal, one awaited filesystem call at a time. Never follows a symbolic link. */
async function removeTreeSerially(target: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isDirectory()) {
    await fsp.unlink(target);
    return;
  }
  // Read the whole listing first: removing entries while a directory stream is open can skip some.
  const entries = await fsp.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) await removeTreeSerially(full);
    else await fsp.unlink(full);
  }
  await fsp.rmdir(target);
}

export class SafeFsExecutor {
  /**
   * Recursive force-deletes default to fs.rm's native transient-error retry
   * (ENOTEMPTY/EBUSY/EPERM). A recursive tree delete racing a concurrent
   * writer (git finishing an object write, an mtime scanner walking the
   * tree) fails ENOTEMPTY exactly once and succeeds milliseconds later —
   * fs.rm retries this class natively, but only when maxRetries is set.
   * Live: CI shard failure 2026-06-05 in handoff-manager.test.ts cleanup
   * (`ENOTEMPTY: directory not empty, rmdir '/tmp/handoff-…/.git'`) on a
   * loaded runner — a whole-class flake every tmpdir-cleanup test inherits.
   * Explicit caller-set values always win; non-recursive deletes unchanged.
   */
  /**
   * Retry budget for recursive+force removals.
   *
   * Raised from 3x100ms (~300ms) to 10x100ms (~1s) after a CI failure on main
   * (2026-07-28): `ENOTEMPTY` on `rmdir` of a temp dir's `.git`, from a test whose
   * setup runs real `git add` + `git commit`. The retries WERE in force — they
   * simply ran out. A git child process (or its index.lock) can outlive a
   * ~300ms window when the runner is loaded, so the teardown raced a process
   * still writing into the directory.
   *
   * This widens the budget; it does not prove any budget is sufficient. A
   * removal that is genuinely blocked now fails after ~1s instead of ~300ms,
   * which costs nothing — the operation was going to fail either way. The
   * deeper fix for the git case is ensuring the child has exited before
   * teardown, which belongs with the tests rather than here.
   *
   * Only applied when the caller did not specify `maxRetries`, so an explicit
   * choice always wins.
   */
  private static withRmRetryDefaults<T extends fs.RmOptions>(rmOpts: T): T {
    if (rmOpts.recursive && rmOpts.force && rmOpts.maxRetries === undefined) {
      return { ...rmOpts, maxRetries: 10, retryDelay: 100 };
    }
    return rmOpts;
  }

  /** Async fs.promises.rm wrapper. */
  static async safeRm(target: string, opts: SafeRmOptions): Promise<void> {
    const { operation, localVerifyScopeOk, worktreeTrashScope, feedbackCanaryScope, gitRebaseStateScope, learnedSkillScope, nodeModulesCloneStagingScope, ...rmOpts } = opts;
    void feedbackCanaryScope; void gitRebaseStateScope; void learnedSkillScope; void nodeModulesCloneStagingScope;
    const canonical = guard(target, operation, 'safeRm', rmOp(opts), trashOf(worktreeTrashScope));
    void localVerifyScopeOk;
    try {
      await fsp.rm(target, SafeFsExecutor.withRmRetryDefaults(rmOpts));
      audit('safeRm', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRm', operation, canonical, 'denied', `rm-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Async recursive remove that issues ONE filesystem call at a time.
   *
   * `safeRm` (fs.promises.rm) removes a directory by starting a call for every child at once.
   * For a tree of several hundred thousand files that queues the whole tree on libuv's four
   * threadpool threads, and every other async file read, DNS lookup, zlib and crypto call in
   * the process waits behind it for as long as the delete takes. This walk awaits each call
   * before the next, so it holds at most one of the four threads. Use it for large trees
   * removed inside a long-running server. Symbolic links are removed, never followed.
   *
   * If the walk fails part-way (a racing writer, an unreadable directory), what is left is
   * removed with `fs.promises.rm` and its retry defaults. Missing targets are a no-op.
   */
  static async safeRmTreeSerial(target: string, opts: SafeFsOptions): Promise<void> {
    const { operation } = opts;
    const canonical = guard(target, operation, 'safeRmTreeSerial', { verb: 'rm', recursive: true, force: true, scopes: { ...scopesOf(opts), localVerifyScopeOk: undefined } }, trashOf(opts.worktreeTrashScope));
    try {
      try {
        await removeTreeSerially(target);
      } catch {
        // @silent-fallback-ok: the fallback below either finishes the removal or throws and is audited as denied.
        await fsp.rm(target, SafeFsExecutor.withRmRetryDefaults({ recursive: true, force: true }));
      }
      audit('safeRmTreeSerial', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmTreeSerial', operation, canonical, 'denied', `rm-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Rename a worktree checkout into the reaper's trash (spec reaper-removal-out-of-process §2).
   * Requires `worktreeTrashScope`: the source must be a real folder directly
   * under the realpath of `worktreesDir` (not `.trash`) and in `allowedSources`;
   * the destination must not exist, must be strictly inside the realpath of
   * `trashRoot`, and must be on the same volume as the source (same `st_dev`), so
   * `rename(2)` is atomic. Refuses otherwise, before touching anything.
   */
  static safeRenameDirSync(source: string, destination: string, opts: SafeFsOptions & { worktreeTrashScope: WorktreeTrashScope }): void {
    if (!opts.worktreeTrashScope) throw new WorktreeTrashScopeError(source, opts.operation, 'safeRenameDirSync requires worktreeTrashScope');
    const src = guard(source, opts.operation, 'safeRenameDirSync', null, { scope: opts.worktreeTrashScope, role: 'rename-source' });
    const dest = guard(destination, opts.operation, 'safeRenameDirSync', null, { scope: opts.worktreeTrashScope, role: 'trash' });
    const refuse = (reason: string): never => {
      audit('safeRenameDirSync', opts.operation, `${src} -> ${dest}`, 'denied', reason);
      throw new WorktreeTrashScopeError(source, opts.operation, reason);
    };
    try { fs.lstatSync(dest); refuse('the destination already exists'); }
    catch (err) { if (err instanceof WorktreeTrashScopeError) throw err; if ((err as NodeJS.ErrnoException).code !== 'ENOENT') refuse(`the destination cannot be checked: ${(err as Error).message}`); }
    let srcDev: number;
    let destDev: number;
    try { srcDev = fs.lstatSync(src).dev; destDev = fs.statSync(path.dirname(dest)).dev; }
    catch (err) { return refuse(`volume check failed: ${(err as Error).message}`); }
    if (srcDev !== destDev) refuse('source and destination are on different volumes');
    try {
      fs.renameSync(src, dest);
      audit('safeRenameDirSync', opts.operation, `${src} -> ${dest}`, 'allowed');
    } catch (err) {
      audit('safeRenameDirSync', opts.operation, `${src} -> ${dest}`, 'denied', `rename-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Delete a folder inside the reaper's trash in its own sub-process
   * (spec reaper-removal-out-of-process §2): `guard()` with `worktreeTrashScope`
   * (and its audit row), then `rm -rf -- <canonical path>` with no shell. BSD and
   * GNU `rm -r` remove a symlink as a link and never follow it; `-f` keeps an
   * unwritable file from stopping it at a prompt. The sub-process is killed at
   * `timeoutMs`. Records `allowed` or `denied` when it exits. Resolves (never
   * rejects) once the process has exited; a guard refusal throws before any
   * process starts.
   */
  static safeRmTreeInSubprocess(target: string, opts: SafeFsOptions & { worktreeTrashScope: WorktreeTrashScope; timeoutMs: number }): Promise<SubprocessRmResult> {
    if (!opts.worktreeTrashScope) throw new WorktreeTrashScopeError(target, opts.operation, 'safeRmTreeInSubprocess requires worktreeTrashScope');
    const canonical = guard(target, opts.operation, 'safeRmTreeInSubprocess', null, { scope: opts.worktreeTrashScope, role: 'trash' });
    return new Promise((resolve) => {
      let timedOut = false;
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (r: SubprocessRmResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        audit('safeRmTreeInSubprocess', opts.operation, canonical, r.ok ? 'allowed' : 'denied', r.ok ? undefined : `rm-subprocess: ${r.error ?? 'failed'}`);
        resolve(r);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('rm', ['-rf', '--', canonical], { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      } catch (err) {
        finish({ ok: false, exitCode: null, signal: null, timedOut: false, error: `spawn failed: ${(err as Error).message}` });
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* @silent-fallback-ok — already exited; the exit handler records the outcome */ }
      }, Math.max(0, opts.timeoutMs));
      timer.unref?.();
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 2_000) stderr += d.toString('utf8'); });
      child.once('error', (err) => finish({ ok: false, exitCode: null, signal: null, timedOut, error: `rm failed to run: ${err.message}` }));
      child.once('close', (code, signal) => {
        const ok = code === 0 && !timedOut;
        finish({
          ok, exitCode: code, signal: signal ?? null, timedOut,
          ...(ok ? {} : { error: timedOut ? `killed at the ${opts.timeoutMs} ms budget` : `rm exited ${code ?? signal}: ${stderr.trim().slice(0, 300)}` }),
        });
      });
    });
  }

  /** Sync fs.rmSync wrapper. */
  static safeRmSync(target: string, opts: SafeRmOptions): void {
    const { operation, localVerifyScopeOk, worktreeTrashScope, feedbackCanaryScope, gitRebaseStateScope, learnedSkillScope, nodeModulesCloneStagingScope, ...rmOpts } = opts;
    void feedbackCanaryScope; void gitRebaseStateScope; void learnedSkillScope; void nodeModulesCloneStagingScope;
    const canonical = guard(target, operation, 'safeRmSync', rmOp(opts), trashOf(worktreeTrashScope));
    void localVerifyScopeOk;
    try {
      fs.rmSync(target, SafeFsExecutor.withRmRetryDefaults(rmOpts));
      audit('safeRmSync', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmSync', operation, canonical, 'denied', `rm-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Async fs.promises.unlink wrapper. */
  static async safeUnlink(target: string, opts: SafeFsOptions): Promise<void> {
    const canonical = guard(target, opts.operation, 'safeUnlink', { verb: 'unlink', recursive: false, force: false, scopes: scopesOf(opts) }, trashOf(opts.worktreeTrashScope));
    try {
      await fsp.unlink(target);
      audit('safeUnlink', opts.operation, canonical, 'allowed');
    } catch (err) {
      audit('safeUnlink', opts.operation, canonical, 'denied', `unlink-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Sync fs.unlinkSync wrapper. */
  static safeUnlinkSync(target: string, opts: SafeFsOptions): void {
    const canonical = guard(target, opts.operation, 'safeUnlinkSync', { verb: 'unlink', recursive: false, force: false, scopes: scopesOf(opts) }, trashOf(opts.worktreeTrashScope));
    try {
      fs.unlinkSync(target);
      audit('safeUnlinkSync', opts.operation, canonical, 'allowed');
    } catch (err) {
      audit('safeUnlinkSync', opts.operation, canonical, 'denied', `unlink-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Async fs.promises.rmdir wrapper. */
  static async safeRmdir(target: string, opts: SafeRmDirOptions): Promise<void> {
    const { operation, worktreeTrashScope, localVerifyScopeOk, feedbackCanaryScope, gitRebaseStateScope, learnedSkillScope, nodeModulesCloneStagingScope, ...rmOpts } = opts;
    void localVerifyScopeOk; void feedbackCanaryScope; void gitRebaseStateScope; void learnedSkillScope; void nodeModulesCloneStagingScope;
    const canonical = guard(target, operation, 'safeRmdir', { verb: 'rmdir', recursive: !!(rmOpts as { recursive?: boolean }).recursive, force: false, scopes: { ...scopesOf(opts), localVerifyScopeOk: undefined } }, trashOf(worktreeTrashScope));
    try {
      await fsp.rmdir(target, rmOpts);
      audit('safeRmdir', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmdir', operation, canonical, 'denied', `rmdir-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Sync fs.rmdirSync wrapper. */
  static safeRmdirSync(target: string, opts: SafeRmDirOptions): void {
    const { operation, worktreeTrashScope, localVerifyScopeOk, feedbackCanaryScope, gitRebaseStateScope, learnedSkillScope, nodeModulesCloneStagingScope, ...rmOpts } = opts;
    void localVerifyScopeOk; void feedbackCanaryScope; void gitRebaseStateScope; void learnedSkillScope; void nodeModulesCloneStagingScope;
    const canonical = guard(target, operation, 'safeRmdirSync', { verb: 'rmdir', recursive: !!(rmOpts as { recursive?: boolean }).recursive, force: false, scopes: { ...scopesOf(opts), localVerifyScopeOk: undefined } }, trashOf(worktreeTrashScope));
    try {
      fs.rmdirSync(target, rmOpts);
      audit('safeRmdirSync', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmdirSync', operation, canonical, 'denied', `rmdir-error: ${(err as Error).message}`);
      throw err;
    }
  }

  // ── Atomic write ────────────────────────────────────────────────────
  //
  // Crash-safe file writes for file-backed state. The failure these prevent:
  // a direct `fs.writeFileSync` truncates the target THEN writes; if the
  // process crashes (or the disk fills) mid-write, the file is left
  // truncated or partially written — and for append-only event logs / JSON
  // state, that means silent data loss when the next reader hits a parse
  // error and falls back to an empty skeleton.
  //
  // The pattern: write to a sibling temp file in the SAME directory (so the
  // rename stays on one filesystem and is therefore atomic per POSIX),
  // fsync the data to durable storage, then rename over the target. A crash
  // at any point leaves EITHER the old file intact OR the fully-written new
  // file — never a half-written one.
  //
  // Cherry-picked into Instar 2026-05-23 from the GSD-Instar integration
  // spike (gsd-executor Rule 2 finding: file-backed state lacked atomic
  // writes). Not a destructive op, so it does not go through the
  // source-tree guard — but it lives here as the natural home for safe-fs
  // primitives and shares the audit trail.

  /**
   * Atomically write a string to `target`. Writes to a temp sibling, fsyncs,
   * then renames over the target. Creates parent directories if missing.
   */
  static atomicWriteFileSync(target: string, data: string | Uint8Array, opts?: { operation?: string; mode?: number }): void {
    const operation = opts?.operation ?? 'atomicWriteFileSync';
    const resolved = path.resolve(target);
    const dir = path.dirname(resolved);
    // Ensure parent dir exists (matches the convenience of writeFileSync callers
    // who often forget mkdir).
    fs.mkdirSync(dir, { recursive: true });
    // Temp file in the SAME directory so rename is atomic (same filesystem).
    const tmp = path.join(dir, `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, 'w', opts?.mode ?? 0o644);
      fs.writeSync(fd, data as never);
      fs.fsyncSync(fd);   // flush data to durable storage before rename
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, resolved);  // atomic replace
      audit('atomicWriteFileSync', operation, resolved, 'allowed');
    } catch (err) {
      // Best-effort cleanup of the temp file; never mask the original error.
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      audit('atomicWriteFileSync', operation, resolved, 'denied', `write-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Atomically write `value` as pretty-printed JSON to `target`.
   * Convenience wrapper around atomicWriteFileSync — the common case for
   * Instar's `.instar/state/*.json` files.
   */
  static atomicWriteJsonSync(target: string, value: unknown, opts?: { operation?: string; mode?: number; indent?: number }): void {
    const json = JSON.stringify(value, null, opts?.indent ?? 2);
    this.atomicWriteFileSync(target, json, { operation: opts?.operation ?? 'atomicWriteJsonSync', mode: opts?.mode });
  }
}

// Re-export the guard error so call-site catch blocks don't have to import
// from two modules.
export { SourceTreeGuardError };
