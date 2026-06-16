/**
 * PrHandLease — per-branch ownership lease so two of the agent's OWN concurrent
 * sessions ("hands") cannot push competing commits to the same branch.
 *
 * Spec: docs/specs/parallel-hand-pr-lease.md (review-convergence + approved).
 * Closes the push-competition cause of the 2026-06-15 PR #1183 merge thrash.
 *
 * Design anchors (from the converged spec):
 *  - Identity = holderTopicId (stable across the constant session respawns);
 *    holderSessionId is a LIVENESS-PROBE HANDLE ONLY, never the identity (§3.2/B2).
 *  - ONE process-wide lock guards the single JSON file (matching ResumeQueue's
 *    single lockPath); per-record compare-and-swap under that lock (§3.3/B3/M-D).
 *  - Liveness probe is TTL-gated (only when a lease is past ttl) and reads the
 *    in-memory running set — never a tmux exec (§3.5/M4).
 *  - A holder on a DIFFERENT machine is NEVER judged dead from local session
 *    absence (§3.5/M6); foreign-machine holder → fail-closed → treat as live.
 *  - maxHold ceiling is liveness-discriminated: a DEAD/foreign-unverified holder
 *    past the ceiling is CAS-seized + attention; a LIVE same-machine holder past
 *    the ceiling is NOT seized — the caller escalates instead (§3.9/codex#3).
 *  - Unreadable/corrupt/absent state file → fail-OPEN (treat as no lease) (§3.4/M10).
 *  - dryRun leases carry dryRun:true; non-acquisition readers MUST ignore them (§5).
 *
 * This module is the STORE + the pure key-derivation helpers. The PreToolUse Bash
 * hook (pr-hand-lease-guard.js) and the GET /pr-leases route consume it. Enforcement
 * is the hook's (the real chokepoint where agent `git push` runs); SafeGitExecutor
 * carries the same check as defense-in-depth for instar's own internal pushes.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export type LeaseIntent = 'build' | 'rework' | 'merge';
export type LeaseTombstoneStatus = 'released' | 'merged' | 'abandoned';

export interface PrHandLeaseRecord {
  /** STABLE logical owner — the conversation topic. Survives session respawn. */
  holderTopicId: number;
  /** Liveness-probe handle ONLY (tmux session name). NEVER the identity. */
  holderSessionId: string;
  /** Load-bearing for the never-falsely-dead rule (§3.5/M6). */
  holderMachineId: string;
  /** Secondary metadata once the PR exists; never the primary key. */
  prNumber?: number | null;
  intent: LeaseIntent;
  acquiredAt: number;
  renewedAt: number;
  ttlMs: number;
  maxHoldMs: number;
  /** Observe-only soak: a dryRun lease MUST be ignored by all non-acquisition readers. */
  dryRun?: boolean;
  /** Set only on a tombstoned (released) record; a tombstone is never a live holder. */
  tombstone?: { status: LeaseTombstoneStatus; at: number };
}

/** Derived liveness reported by GET /pr-leases — honest, computed, never the raw record. */
export type DerivedLeaseLiveness = 'live' | 'stale-dead' | 'stale-ttl' | 'tombstoned' | 'foreign-machine';

export interface LeaseEvalResult {
  /** What the push chokepoint should do. */
  decision: 'allow' | 'deny' | 'escalate';
  reason: string;
  holder?: PrHandLeaseRecord;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30m dead-holder backstop
const DEFAULT_MAX_HOLD_MS = 90 * 60 * 1000; // 90m absolute ceiling
const TOMBSTONE_WINDOW_MS = 5 * 1000; // ≤5s re-grab guard

export interface PrHandLeaseDeps {
  stateDir: string;
  machineId: string;
  /** Returns the tmux session names currently running (in-memory; no tmux exec). */
  runningSessionNames: () => string[];
  /** ms clock (injectable for tests). */
  now?: () => number;
  /** Emitted on a forced release / fail-open recurrence for the attention surface. */
  onAttention?: (item: { kind: string; detail: string }) => void;
  /** Structured audit sink — one row per acquire/renew/yield/auto-heal/release. */
  onAudit?: (row: Record<string, unknown>) => void;
}

/**
 * Canonicalize a `git push` command's destination ref to `refs/heads/<name>`.
 * Two-tier (§3.1): explicit refspec / local @{push} fast path (no network);
 * `git push --dry-run --porcelain` only for the ambiguous case, timeout-bounded.
 * Returns null when no branch key is derivable (detached, tag, delete, resolver
 * error/timeout) → the caller FAILS OPEN (does not gate).
 */
export function canonicalPushKey(command: string, cwd: string, opts?: { execTimeoutMs?: number }): string | null {
  // Extract the git push invocation from a possibly-composite command
  // (cd && git push, env-prefix, git -C path push, command git push, multiline).
  // We do not try to defeat obfuscation/aliases/script-bodies — that is an
  // accepted residual evasion of a cooperative guard (§2 non-goal).
  const pushMatch = command.match(/\bgit\b[^\n;&|]*\bpush\b([^\n;&|]*)/);
  if (!pushMatch) return null;
  const tail = pushMatch[1] ?? '';

  // Ref deletion → no commit content → not gated.
  if (/--delete\b/.test(tail) || /(^|\s):refs?\/|(^|\s):\S/.test(tail)) return null;

  // -C <dir> overrides cwd for resolution.
  const cMatch = command.match(/\bgit\b\s+(?:[^\n]*?\s)?-C\s+(\S+)/);
  const effectiveCwd = cMatch ? resolveDir(cwd, stripQuotes(cMatch[1])) : cwd;

  // Fast path: an explicit refspec token (last non-flag arg that isn't the remote).
  const explicit = parseExplicitRefspec(tail);
  if (explicit) return `branch:${explicit}`;

  // No explicit refspec → resolve the push destination locally via git's own
  // ref resolution (no network — `rev-parse @{push}` reads config only). If that
  // can't resolve it (no upstream / ambiguous push.default), FAIL-OPEN (no key):
  // we never contact the remote from the push hot-path, and an unresolvable ref is
  // the safe direction (the push proceeds). This deliberately drops the earlier
  // remote-contacting `push --dry-run` fallback — it removes the hang surface the
  // round-4 review flagged AND keeps the resolver off the network entirely.
  const local = resolveLocalPushRef(effectiveCwd, opts?.execTimeoutMs);
  return local ? `branch:${local}` : null;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}

function resolveDir(cwd: string, dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}

/** Parse `origin foo` / `origin HEAD:foo` / `origin HEAD:refs/heads/foo` → refs/heads/foo. */
function parseExplicitRefspec(tail: string): string | null {
  // Drop flags; tokens left are [remote] [refspec...].
  const tokens = tail.split(/\s+/).filter((t) => t && !t.startsWith('-'));
  // remote is the first bare token; a refspec is any token containing ':' or a bare branch after the remote.
  for (const tok of tokens) {
    const t = stripQuotes(tok);
    if (t.includes(':')) {
      const dst = t.split(':')[1];
      return normalizeHeadsRef(dst);
    }
  }
  // bare `git push origin foo` → tokens [origin, foo]; foo is the destination branch.
  if (tokens.length >= 2) {
    return normalizeHeadsRef(stripQuotes(tokens[1]));
  }
  return null;
}

function normalizeHeadsRef(ref: string | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith('refs/heads/')) return ref;
  if (ref.startsWith('refs/')) return null; // tag/non-heads → not gated
  if (ref === 'HEAD') return null; // unresolved here; local resolver handles it
  return `refs/heads/${ref}`;
}

function resolveLocalPushRef(cwd: string, timeoutMs?: number): string | null {
  try {
    const out = SafeGitExecutor.readSync(['rev-parse', '--symbolic-full-name', '@{push}'], {
      cwd,
      operation: 'pr-hand-lease canonical-key resolve',
      encoding: 'utf-8',
      timeout: timeoutMs ?? 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    if (out.startsWith('refs/remotes/')) {
      // refs/remotes/<remote>/<branch> → refs/heads/<branch>
      const parts = out.split('/');
      const branch = parts.slice(3).join('/');
      return branch ? `refs/heads/${branch}` : null;
    }
    if (out.startsWith('refs/heads/')) return out;
    return null;
  } catch {
    // @silent-fallback-ok: no upstream / unresolvable push.default → no key → caller FAILS OPEN
    // (the push proceeds). We never contact the remote from the push hot-path.
    return null;
  }
}

export class PrHandLease {
  private readonly d: PrHandLeaseDeps;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private failOpenCounts = new Map<string, number>();

  constructor(deps: PrHandLeaseDeps) {
    this.d = deps;
    const root = path.join(deps.stateDir, 'state');
    this.filePath = path.join(root, 'pr-hand-leases.json');
    this.lockPath = path.join(root, 'pr-hand-leases.lock');
    this.now = deps.now ?? (() => Date.now());
  }

  /** The path the BackupManager denylist must exclude (ephemeral, never restored). */
  static stateFileRelPath(): string {
    return 'state/pr-hand-leases.json';
  }

  /**
   * Evaluate a push against the lease for `key` (from canonicalPushKey).
   * Returns the chokepoint decision. NEVER throws — any internal error resolves
   * to allow (the hook's own-crash fail-open is the outer guarantee; this is the
   * inner one).
   */
  evaluate(key: string, myTopicId: number, mySessionId: string): LeaseEvalResult {
    try {
      const all = this.readAll(); // fail-open on corrupt → {}
      const rec = all[key];
      if (!rec || rec.tombstone) {
        return { decision: 'allow', reason: rec?.tombstone ? 'tombstoned-free' : 'no-lease' };
      }
      if (rec.holderTopicId === myTopicId) {
        return { decision: 'allow', reason: 'own-topic', holder: rec };
      }
      // dryRun leases never block a different hand (observe-only).
      if (rec.dryRun) {
        return { decision: 'allow', reason: 'foreign-dryrun-ignored', holder: rec };
      }

      const t = this.now();
      const sameMachine = rec.holderMachineId === this.d.machineId;
      const ttlExpired = t - rec.renewedAt > rec.ttlMs;
      const pastCeiling = t - rec.acquiredAt > rec.maxHoldMs;

      // Ceiling override FIRST (§3.9 precedence — overrides foreign-machine conservatism).
      if (pastCeiling) {
        if (sameMachine && this.isSessionRunning(rec)) {
          // LIVE same-machine holder past ceiling → escalate, do NOT seize (codex#3/§3.9).
          return { decision: 'escalate', reason: 'live-holder-past-ceiling', holder: rec };
        }
        // DEAD same-machine OR foreign-machine-unverified past ceiling → stale → caller seizes (+attention).
        return { decision: 'allow', reason: 'stale-past-ceiling', holder: rec };
      }

      // Within ceiling:
      if (!ttlExpired) {
        // TTL-gate: a fresh lease is live without probing.
        return { decision: 'deny', reason: 'live-foreign-lease', holder: rec };
      }
      if (!sameMachine) {
        // Foreign-machine holder within ceiling, past TTL → NEVER judged dead from local
        // session absence → yield (§3.5/M6).
        return { decision: 'deny', reason: 'foreign-machine-within-ceiling', holder: rec };
      }
      // Same-machine, TTL-expired → probe the in-memory running set.
      if (this.isSessionRunning(rec)) {
        return { decision: 'deny', reason: 'live-foreign-lease', holder: rec };
      }
      return { decision: 'allow', reason: 'stale-dead', holder: rec };
    } catch (err) {
      // Inner fail-open — never block on an internal error.
      this.audit({ event: 'evaluate-error', key, error: String(err) });
      return { decision: 'allow', reason: 'eval-error-failopen' };
    }
  }

  /** Acquire or renew the lease for `key` for my (topic, session, machine). Atomic CAS under the lock. */
  acquireOrRenew(
    key: string,
    holder: { topicId: number; sessionId: string; intent?: LeaseIntent; prNumber?: number | null; dryRun?: boolean },
  ): PrHandLeaseRecord {
    return this.withLock(() => {
      const all = this.readAllUnlocked();
      const existing = all[key];
      const t = this.now();
      if (existing && !existing.tombstone && existing.holderTopicId === holder.topicId) {
        existing.renewedAt = t;
        existing.holderSessionId = holder.sessionId;
        if (holder.intent) existing.intent = holder.intent;
        if (holder.prNumber !== undefined) existing.prNumber = holder.prNumber;
        if (holder.dryRun !== undefined) existing.dryRun = holder.dryRun;
        this.persist(all);
        this.audit({ event: 'renew', key, topicId: holder.topicId, dryRun: !!holder.dryRun });
        return existing;
      }
      const rec: PrHandLeaseRecord = {
        holderTopicId: holder.topicId,
        holderSessionId: holder.sessionId,
        holderMachineId: this.d.machineId,
        prNumber: holder.prNumber ?? null,
        intent: holder.intent ?? 'build',
        acquiredAt: t,
        renewedAt: t,
        ttlMs: DEFAULT_TTL_MS,
        maxHoldMs: DEFAULT_MAX_HOLD_MS,
        dryRun: holder.dryRun || undefined,
      };
      all[key] = rec;
      this.persist(all);
      this.audit({ event: 'acquire', key, topicId: holder.topicId, dryRun: !!holder.dryRun });
      return rec;
    });
  }

  /**
   * Atomic-CAS takeover of a stale lease (§3.3/B3). Writes my record only if the
   * on-disk record still matches the observed (holderTopicId, acquiredAt). Returns
   * the new record on success, or null if another hand healed first (loser yields).
   */
  takeOverIfStale(
    key: string,
    observed: { holderTopicId: number; acquiredAt: number },
    holder: { topicId: number; sessionId: string; intent?: LeaseIntent; prNumber?: number | null; dryRun?: boolean },
  ): PrHandLeaseRecord | null {
    return this.withLock(() => {
      const all = this.readAllUnlocked();
      const cur = all[key];
      if (!cur || cur.tombstone) {
        // Already free → acquire fresh.
        return this.acquireUnlocked(all, key, holder);
      }
      // CAS precondition: the record must be exactly the one we observed as stale.
      if (cur.holderTopicId !== observed.holderTopicId || cur.acquiredAt !== observed.acquiredAt) {
        this.audit({ event: 'takeover-cas-lost', key });
        return null; // another hand healed first → yield
      }
      const forcedRelease = this.now() - cur.acquiredAt > cur.maxHoldMs;
      const rec = this.acquireUnlocked(all, key, holder);
      this.audit({
        event: forcedRelease ? 'auto-heal-ceiling' : 'auto-heal-dead',
        key,
        priorTopicId: observed.holderTopicId,
        priorMachineId: cur.holderMachineId,
      });
      if (forcedRelease || cur.holderMachineId !== this.d.machineId) {
        this.attention('pr-lease-forced-release', `Branch ${key} lease force-released from topic ${observed.holderTopicId} (machine ${cur.holderMachineId}).`);
      }
      return rec;
    });
  }

  /** Release my lease (terminal status), tombstoned briefly to guard the re-grab race (§3.7). */
  release(key: string, topicId: number, status: LeaseTombstoneStatus): void {
    this.withLock(() => {
      const all = this.readAllUnlocked();
      const cur = all[key];
      if (cur && cur.holderTopicId === topicId && !cur.tombstone) {
        cur.tombstone = { status, at: this.now() };
        this.persist(all);
        this.audit({ event: 'release', key, topicId, status });
      }
      return undefined;
    });
  }

  /** Read view for GET /pr-leases — each record + its DERIVED (honest) liveness. */
  list(): Array<PrHandLeaseRecord & { key: string; liveness: DerivedLeaseLiveness }> {
    const all = this.readAll();
    const out: Array<PrHandLeaseRecord & { key: string; liveness: DerivedLeaseLiveness }> = [];
    for (const [key, rec] of Object.entries(all)) {
      out.push({ ...rec, key, liveness: this.derivedLiveness(rec) });
    }
    return out;
  }

  // ---- internals ----

  private derivedLiveness(rec: PrHandLeaseRecord): DerivedLeaseLiveness {
    if (rec.tombstone) return 'tombstoned';
    if (rec.holderMachineId !== this.d.machineId) return 'foreign-machine';
    const ttlExpired = this.now() - rec.renewedAt > rec.ttlMs;
    if (!ttlExpired) return 'live';
    return this.isSessionRunning(rec) ? 'live' : 'stale-dead';
  }

  /**
   * Raw same-machine liveness probe: is the holder's tmux session in the
   * in-memory running set? Same key at write + lookup (M-C). On probe error,
   * fail toward LIVE (yield) — uncertainty about the probe must not seize a
   * holder; the caller's past-ceiling path handles a persistently-wedged probe.
   */
  private isSessionRunning(rec: PrHandLeaseRecord): boolean {
    try {
      return this.d.runningSessionNames().includes(rec.holderSessionId);
    } catch {
      // @silent-fallback-ok: probe unavailable → treat live (yield), bounded by the ceiling override.
      return true;
    }
  }

  private acquireUnlocked(
    all: Record<string, PrHandLeaseRecord>,
    key: string,
    holder: { topicId: number; sessionId: string; intent?: LeaseIntent; prNumber?: number | null; dryRun?: boolean },
  ): PrHandLeaseRecord {
    const t = this.now();
    const rec: PrHandLeaseRecord = {
      holderTopicId: holder.topicId,
      holderSessionId: holder.sessionId,
      holderMachineId: this.d.machineId,
      prNumber: holder.prNumber ?? null,
      intent: holder.intent ?? 'build',
      acquiredAt: t,
      renewedAt: t,
      ttlMs: DEFAULT_TTL_MS,
      maxHoldMs: DEFAULT_MAX_HOLD_MS,
      dryRun: holder.dryRun || undefined,
    };
    all[key] = rec;
    this.persist(all);
    return rec;
  }

  /** Read with fail-OPEN on corrupt/absent (§3.4 step 1 / M10). */
  private readAll(): Record<string, PrHandLeaseRecord> {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, PrHandLeaseRecord>;
      return this.pruneExpiredTombstones(parsed);
    } catch (err) {
      // @silent-fallback-ok: corrupt/torn/absent lease file → fail-OPEN (treat as no lease,
      // the push proceeds — a missing lease must NEVER block all pushes). NOT silent:
      // recordFailOpen() logs every occurrence and raises an attention item on recurrence.
      this.recordFailOpen('readAll');
      return {};
    }
  }

  private readAllUnlocked(): Record<string, PrHandLeaseRecord> {
    return this.readAll();
  }

  private pruneExpiredTombstones(all: Record<string, PrHandLeaseRecord>): Record<string, PrHandLeaseRecord> {
    const t = this.now();
    for (const [key, rec] of Object.entries(all)) {
      if (rec.tombstone && t - rec.tombstone.at > TOMBSTONE_WINDOW_MS) delete all[key];
    }
    return all;
  }

  private persist(all: Record<string, PrHandLeaseRecord>): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(all, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath); // atomic swap — readers never see a torn file
  }

  /** One process-wide lock (matching ResumeQueue's single lockPath); 'wx' first-writer-wins. */
  private withLock<T>(fn: () => T): T {
    const dir = path.dirname(this.lockPath);
    fs.mkdirSync(dir, { recursive: true });
    const deadline = this.now() + 5000;
    // simple spin with O_EXCL; the critical section is a sub-ms file rewrite.
    for (;;) {
      let fd: number | null = null;
      try {
        fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: this.now() }));
        fs.closeSync(fd);
        fd = null;
        try {
          return fn();
        } finally {
          try { SafeFsExecutor.safeUnlinkSync(this.lockPath, { operation: 'PrHandLease lock release' }); } catch { /* @silent-fallback-ok: lock cleanup best-effort */ }
        }
      } catch (err: unknown) {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
          // Stale lock recovery: if the lock is older than the deadline window, steal it.
          if (this.now() > deadline) {
            try { SafeFsExecutor.safeUnlinkSync(this.lockPath, { operation: 'PrHandLease stale-lock steal' }); } catch { /* ignore */ }
            continue;
          }
          continue; // retry
        }
        throw err;
      }
    }
  }

  private recordFailOpen(where: string): void {
    const n = (this.failOpenCounts.get(where) ?? 0) + 1;
    this.failOpenCounts.set(where, n);
    this.audit({ event: 'fail-open', where, count: n });
    if (n >= 3) {
      this.attention('pr-lease-failopen', `pr-hand-leases.json repeatedly unreadable (${n}x at ${where}) — lease protection degraded; check the state file.`);
    }
  }

  private attention(kind: string, detail: string): void {
    try { this.d.onAttention?.({ kind, detail }); } catch { /* @silent-fallback-ok */ }
  }

  private audit(row: Record<string, unknown>): void {
    try { this.d.onAudit?.({ ...row, ts: new Date(this.now()).toISOString() }); } catch { /* @silent-fallback-ok */ }
  }
}
