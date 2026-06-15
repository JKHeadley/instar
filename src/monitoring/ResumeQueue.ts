/**
 * ResumeQueue — the durable, ordered queue of mid-work reaped sessions
 * awaiting revival (reap-notify spec R2.2/R2.3, parts of R2.9/R2.10).
 *
 * One queue per machine, JSON-file backed (`state/resume-queue.json`),
 * in-memory authoritative with SYNCHRONOUS persist on every mutation using
 * the crash-durable discipline: write temp → fsync temp → rename → fsync
 * parent dir. A crash loses at most the latest mutation, which boot
 * reconciliation absorbs (a lost enqueue is re-created from the reap-log; a
 * lost transition replays as a failed attempt).
 *
 * Single-writer is ENFORCED, not assumed: a lockfile
 * (`state/resume-queue.lock`, pid + hostname + heartbeat mtime) is taken at
 * start. Stale-lock recovery is automatic on the SAME host (dead pid or old
 * heartbeat ⇒ reclaim + log); a LIVE other process disables the queue loudly.
 * HARD INVARIANT: a lock whose hostname differs from this host is NEVER
 * liveness-probed or reclaimed — pid checks are meaningless cross-host — it
 * disables the queue loudly instead, and the disable message documents the
 * operational recovery (verify nothing else uses the state dir, delete the
 * lock, restart).
 *
 * Eligibility (R2.2) is stricter than midWork: terminal + autonomous +
 * (≥1 strong signal, OR topic-bound with ≥2 distinct weak signals); jobs
 * must opt in (`resumeOnReap:true`, default false); sessions with neither a
 * topic binding nor a jobSlug are excluded at enqueue; operator kills
 * excluded by default; watchdog stuck-kills and topic-moved closeouts never
 * queue. The resurrection LEDGER (keyed on stable identity
 * `topicId ?? jobSlug ?? tmuxSession`, tombstones surviving dequeue, 24h
 * reset window) caps kill-resume-kill loops at `maxResurrections`.
 *
 * Dry-run posture (the fleet's shipped default): entries ARE durably
 * enqueued (observable in `GET /sessions/resume-queue` — the soak needs real
 * midWork entries), but the drainer never spawns (it audits `would-resume`)
 * and nothing user-facing claims a queued resume. Deliberate interpretation
 * of "observe-only", recorded in the side-effects review.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { evidenceEligible, clampWorkEvidence, isAutoResumableEmergencyPauseReason } from '../core/WorkEvidence.js';

export type ResumePriorityClass = 'interactive' | 'job' | 'other';

export type ResumeEntryStatus =
  | 'queued'
  | 'starting'
  | 'respawned'
  | 'failed'
  | 'cancelled'
  | `invalidated:${string}`
  | `gave-up:${string}`;

export interface ResumeQueueEntry {
  id: string;
  queuedAt: string;
  /** TTL re-anchor on an operator requeue (R2.10); TTL keys on max(queuedAt, requeuedAt). */
  requeuedAt?: string;
  /** Stable identity: topicId ?? jobSlug ?? tmuxSession (R2.3). */
  stableKey: string;
  sessionName: string;
  tmuxSession: string;
  topicId?: number;
  /** Conversation-resume UUID snapshot at enqueue time (R2.6 revalidates). */
  resumeUuid?: string;
  jobSlug?: string;
  cwd: string;
  worktreePath?: string;
  priorityClass: ResumePriorityClass;
  reason: string;
  workEvidence: string[];
  attempts: number;
  status: ResumeEntryStatus;
  lastAttemptAt?: string;
  /** Backoff hold between attempts (R2.9). */
  nextAttemptAt?: string;
  /** Milliseconds of operator-pause time excluded from this entry's TTL clock. */
  frozenMs?: number;
  /** TTL expiry under sustained pressure carries this marker (R2.9). */
  pressureStarved?: boolean;
}

/** Tombstone ledger row — survives dequeue (R2.9 resurrection cap). */
export interface ResurrectionTombstone {
  stableKey: string;
  resurrections: number;
  windowStartAt: string;
  lastResumeAt?: string;
}

/**
 * FD1 — Is the resume-queue state dir on a HOST-LOCAL filesystem (not a network/
 * shared mount)? FAIL-CLOSED: anything we cannot positively confirm as local
 * returns false, so a genuine shared volume is NEVER auto-healed (the two-hosts-
 * one-volume corruption the host-lock invariant protects against). Portable
 * device-column classification via `df -P` (field 1 of the data row):
 *   - `/dev/...`           → local disk          → true
 *   - `host:/path` (NFS) / `//host/share` (SMB)  → network             → false
 *   - df failure / timeout / unparseable / unknown source → false (fail-closed)
 * Checked ONCE at lock-acquisition. Exported for the unit truth-table + canary.
 */
export function isStateDirHostLocalDefault(stateDir: string): boolean {
  let out: string;
  try {
    out = execFileSync('df', ['-P', stateDir], { timeout: 3000, encoding: 'utf-8' });
  } catch {
    // @silent-fallback-ok — df unavailable/failed ⇒ cannot confirm local ⇒
    // fail-closed to NOT-local (the safe direction: never auto-heal on doubt).
    return false;
  }
  const lines = out.trim().split('\n');
  if (lines.length < 2) return false; // unparseable → fail-closed
  const source = lines[1]?.trim().split(/\s+/)[0] ?? '';
  return classifyDfSourceLocal(source);
}

/**
 * Pure FD1 classifier over the `df -P` device-source column. Exported for the
 * unit truth-table + drift canary. FAIL-CLOSED: only a positively-recognized
 * local block device is local; network signatures and anything unrecognized
 * (map/tmpfs/empty) are NOT local.
 */
export function classifyDfSourceLocal(source: string): boolean {
  if (!source) return false;
  // Network/shared mount signatures → NOT local.
  if (source.startsWith('//')) return false; // SMB/CIFS //host/share
  if (/^[^/][^:]*:/.test(source)) return false; // NFS host:/path (a colon before any slash)
  // Positively-local: a real block device.
  if (source.startsWith('/dev/')) return true;
  // map (devfs/autofs), tmpfs, anything else we don't recognize → fail-closed.
  return false;
}

export interface ResumeQueueConfig {
  enabled: boolean;
  dryRun: boolean;
  /**
   * FD5 — auto-heal a stale FOREIGN-host lock when it is provably a single-host
   * RENAME (local FS + dead pid + stale heartbeat), instead of disabling the
   * queue. Fleet code-default FALSE (touches a durable-state-corruption
   * invariant — never "cheap"); the dev-agent gate flips it true at the
   * consumption site, dryRun-first. When false → today's disable-on-mismatch.
   */
  autoHealStaleHostLock: boolean;
  maxAttempts: number;
  maxResurrections: number;
  entryTtlHours: number;
  maxQueueSize: number;
  includeOperatorKills: boolean;
}

export const DEFAULT_RESUME_QUEUE_CONFIG: ResumeQueueConfig = {
  enabled: true,
  dryRun: true, // code default — the fleet ships observe-only (decision 2)
  autoHealStaleHostLock: false, // FD5 — fleet code-default OFF; dev-agent gate flips true
  maxAttempts: 3,
  maxResurrections: 2,
  entryTtlHours: 24,
  maxQueueSize: 50,
  includeOperatorKills: false,
};

const RESURRECTION_WINDOW_MS = 24 * 3600_000;
const REASON_CAP = 500;

interface PersistedState {
  version: 1;
  paused: boolean;
  pausedAt?: string;
  pauseReason?: string;
  entries: ResumeQueueEntry[];
  tombstones: ResurrectionTombstone[];
}

export interface EnqueueDecision {
  enqueued: boolean;
  /** Why not (audit vocabulary). */
  why?: string;
  entry?: ResumeQueueEntry;
}

export interface ResumeCandidateInput {
  sessionName: string;
  tmuxSession: string;
  topicId?: number | null;
  jobSlug?: string;
  jobResumeOptIn?: boolean;
  resumeUuid?: string | null;
  cwd: string;
  worktreePath?: string;
  reason: string;
  disposition: 'terminal' | 'recovery-bounce';
  origin: 'operator' | 'autonomous';
  workEvidence: string[];
}

export interface ResumeQueueDeps {
  /** `.instar` state dir — files live under `<stateDir>/state/`. */
  stateDir: string;
  /** Decision-transition audit sink (logs/resume-queue.jsonl). */
  audit?: (event: Record<string, unknown>) => void;
  /** Aggregated attention surface (ONE rolling item — the caller dedupes). */
  raiseAggregated?: (kind: string, detail: string) => void;
  now?: () => number;
  hostname?: () => string;
  /** pid liveness probe (tests override). */
  pidAlive?: (pid: number) => boolean;
  /** FD1 host-local FS probe (tests override; default `isStateDirHostLocalDefault`). */
  isStateDirHostLocal?: (stateDir: string) => boolean;
}

/** Pure eligibility classifier (R2.2) — exported for tests. */
export function classifyEligibility(
  input: ResumeCandidateInput,
  cfg: Pick<ResumeQueueConfig, 'includeOperatorKills'>,
): { eligible: boolean; why?: string } {
  if (input.disposition !== 'terminal') return { eligible: false, why: 'not-terminal' };
  if (input.origin === 'operator' && !cfg.includeOperatorKills) {
    return { eligible: false, why: 'operator-kill' };
  }
  // A stuck session is not interrupted work; resuming recreates the wedge —
  // watchdog escalation owns that recovery (R2.1).
  if (input.reason === 'watchdog-stuck') return { eligible: false, why: 'watchdog-kill' };
  // Post-transfer closeouts: the conversation continues on the owning machine.
  if (input.reason.startsWith('topic moved')) return { eligible: false, why: 'topic-moved' };
  const topicBound = input.topicId != null;
  if (!topicBound && !input.jobSlug) return { eligible: false, why: 'no-resume-path' };
  if (!topicBound && input.jobSlug && !input.jobResumeOptIn) {
    return { eligible: false, why: 'job-not-opted-in' };
  }
  if (!evidenceEligible(input.workEvidence, topicBound)) {
    return { eligible: false, why: 'insufficient-evidence' };
  }
  return { eligible: true };
}

export class ResumeQueue {
  private readonly deps: ResumeQueueDeps;
  private readonly cfg: ResumeQueueConfig;
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly lockPath: string;
  private state: PersistedState = { version: 1, paused: false, entries: [], tombstones: [] };
  private seq = 0;
  /** Non-null ⇒ the queue is disabled (lock conflict / foreign lock). */
  private disabledReason: string | null = null;
  private lockHeld = false;

  constructor(deps: ResumeQueueDeps, cfg?: Partial<ResumeQueueConfig>) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_RESUME_QUEUE_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
    const stateRoot = path.join(deps.stateDir, 'state');
    this.statePath = path.join(stateRoot, 'resume-queue.json');
    this.lockPath = path.join(stateRoot, 'resume-queue.lock');
  }

  config(): ResumeQueueConfig {
    return { ...this.cfg };
  }

  isDisabled(): string | null {
    return this.disabledReason;
  }

  isPaused(): boolean {
    return this.state.paused;
  }

  isDryRun(): boolean {
    return this.cfg.dryRun;
  }

  /**
   * Acquire the single-writer lock + load the durable state. Returns false
   * (queue disabled, reason in `isDisabled()`) on a live-other-process or
   * foreign-host lock — never throws for those.
   */
  start(): boolean {
    if (!this.acquireLock()) return false;
    this.load();
    this.reconcileStartingEntries();
    return true;
  }

  stop(): void {
    if (this.lockHeld) {
      try {
        SafeFsExecutor.safeUnlinkSync(this.lockPath, { operation: 'ResumeQueue.stop lock release' });
      } catch {
        /* already gone */
      }
      this.lockHeld = false;
    }
  }

  /** Refresh the lock heartbeat (drainer calls this every tick). */
  heartbeat(): void {
    if (!this.lockHeld) return;
    try {
      const t = new Date(this.now());
      fs.utimesSync(this.lockPath, t, t);
    } catch {
      /* @silent-fallback-ok — heartbeat touch is best-effort; a missing lock
         is re-created on next start, and a stale heartbeat only makes THIS
         holder's lock reclaimable (the safe direction). */
    }
  }

  private acquireLock(): boolean {
    const hostname = this.deps.hostname?.() ?? os.hostname();
    const pidAlive =
      this.deps.pidAlive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          // @silent-fallback-ok — not a fallback: kill(pid, 0) throwing IS the
          // "pid is dead" answer this probe exists to produce.
          return false;
        }
      });
    try {
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      if (fs.existsSync(this.lockPath)) {
        let lock: { pid?: number; hostname?: string } = {};
        try {
          lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8'));
        } catch {
          // @silent-fallback-ok — corrupt/unreadable lock ⇒ no pid/hostname ⇒
          // the stale-reclaim path below runs and AUDITS the reclaim.
          lock = {};
        }
        if (lock.hostname && lock.hostname !== hostname) {
          // A foreign-host lock. DEFAULT (HARD INVARIANT): treat as a shared-
          // volume conflict and disable WITHOUT probing (the original behavior;
          // a cross-host pid is meaningless here). FD1–FD5: ONLY when auto-heal
          // is ENABLED do we probe to distinguish a single-host RENAME (provably
          // local FS + dead pid + stale heartbeat) and self-heal — fail-closed.
          let fsLocal = false;
          let pidDead = false;
          let foreignHeartbeatStale = false;
          if (this.cfg.autoHealStaleHostLock) {
            const foreignMtime = (() => {
              try {
                return fs.statSync(this.lockPath).mtimeMs;
              } catch {
                // @silent-fallback-ok — unreadable mtime ⇒ heartbeat treated as
                // stale (one of three conjunctive conditions; FS-local still gates).
                return 0;
              }
            })();
            foreignHeartbeatStale = this.now() - foreignMtime >= 5 * 60_000;
            const isHostLocal = this.deps.isStateDirHostLocal ?? isStateDirHostLocalDefault;
            // FD2: FS-local is DISPOSITIVE and evaluated first. A foreign lock on
            // a non-local/unknown FS is treated as a genuine shared-volume case.
            fsLocal = (() => {
              try {
                return isHostLocal(this.deps.stateDir);
              } catch {
                // @silent-fallback-ok — detector threw ⇒ cannot confirm local ⇒
                // fail-closed (never auto-heal on doubt).
                return false;
              }
            })();
            // Only probe the pid once FS-local is confirmed — preserves the
            // "never pid-probe a genuine foreign/shared-volume lock" invariant.
            pidDead = fsLocal && (typeof lock.pid !== 'number' || !pidAlive(lock.pid));
          }
          const renameSafe = fsLocal && pidDead && foreignHeartbeatStale;
          if (this.cfg.autoHealStaleHostLock && renameSafe) {
            if (this.cfg.dryRun) {
              // dryRun: log what we WOULD do, do NOT rewrite, then disable. The
              // surface still fires below-equivalent here, so it is never silent.
              this.audit({
                event: 'lock-foreign-host-would-autoheal',
                lockHost: lock.hostname,
                thisHost: hostname,
                fsLocal,
                pidDead,
                foreignHeartbeatStale,
              });
              this.deps.raiseAggregated?.(
                'lock-foreign-host-would-autoheal',
                `resume-queue WOULD auto-heal a stale rename lock from host "${lock.hostname}" → "${hostname}" (dryRun: not rewritten).`,
              );
              this.disabledReason =
                `resume-queue disabled (dryRun): WOULD auto-heal stale rename lock from "${lock.hostname}" → "${hostname}" ` +
                `(fsLocal, pid dead, heartbeat stale). Set dryRun:false to enable the self-heal.`;
              return false;
            }
            // FD4: atomic first-writer-wins takeover. Loser re-evaluates next
            // start (never blind-overwrites).
            const took = this.takeOverLockAtomic(hostname);
            this.audit({ event: 'lock-foreign-host-autohealed', lockHost: lock.hostname, thisHost: hostname, took });
            if (took) {
              this.lockHeld = true;
              this.disabledReason = null;
              return true;
            }
            this.disabledReason =
              `resume-queue disabled: lost the atomic takeover race healing a rename lock from "${lock.hostname}". Re-evaluates next start.`;
            this.deps.raiseAggregated?.('lock-autoheal-lost-race', this.disabledReason);
            return false;
          }
          // Not a safe rename (or auto-heal off): disable + LOUD surface.
          const declined = this.cfg.autoHealStaleHostLock
            ? `Auto-heal declined (fsLocal=${fsLocal}, pidDead=${pidDead}, heartbeatStale=${foreignHeartbeatStale}). `
            : '';
          this.disabledReason =
            `resume-queue disabled: lock at ${this.lockPath} belongs to host "${lock.hostname}" ` +
            `(this host: "${hostname}"). The queue's state dir must be host-local; shared volumes are ` +
            `unsupported. ${declined}Recovery: after verifying nothing else uses this state dir (host renamed, or ` +
            `restored from a backup), delete state/resume-queue.lock and restart.`;
          this.audit({
            event: 'lock-foreign-host',
            lockHost: lock.hostname,
            thisHost: hostname,
            autoHeal: this.cfg.autoHealStaleHostLock,
            fsLocal,
            pidDead,
            foreignHeartbeatStale,
          });
          this.deps.raiseAggregated?.('lock-foreign-host', this.disabledReason);
          return false;
        }
        const mtime = (() => {
          try {
            return fs.statSync(this.lockPath).mtimeMs;
          } catch {
            // @silent-fallback-ok — unreadable mtime ⇒ heartbeat treated as
            // stale ⇒ the audited reclaim path, never a silent hold.
            return 0;
          }
        })();
        const heartbeatFresh = this.now() - mtime < 5 * 60_000;
        const live = typeof lock.pid === 'number' && lock.pid !== process.pid && pidAlive(lock.pid) && heartbeatFresh;
        if (live) {
          this.disabledReason =
            `resume-queue disabled: another live process (pid ${lock.pid}) holds ${this.lockPath} ` +
            `with a fresh heartbeat. Only one queue owner per machine is supported.`;
          this.audit({ event: 'lock-live-other', otherPid: lock.pid });
          this.deps.raiseAggregated?.('lock-live-other', this.disabledReason);
          return false;
        }
        // Dead pid or stale heartbeat — safe automatic reclaim.
        this.audit({ event: 'lock-stale-reclaimed', priorPid: lock.pid, heartbeatFresh });
      }
      fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, hostname }), 'utf-8');
      this.lockHeld = true;
      this.disabledReason = null;
      return true;
    } catch (err) {
      // @silent-fallback-ok — not silent: the failure is stored as
      // disabledReason, surfaced by isDisabled() and the /sessions/resume-queue
      // route, and the queue refuses to start (safe side).
      this.disabledReason = `resume-queue disabled: lock acquisition raised: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /**
   * FD4 — atomic first-writer-wins takeover of a classified-stale lock. Removes
   * the stale lock then creates the new one with O_EXCL ('wx'): exactly one
   * racer's create succeeds; a concurrent boot gets EEXIST → false (it disables
   * and re-evaluates next start, never blind-overwrites). The next-acquire
   * live-pid + heartbeat check backstops the ultra-narrow double-unlink window.
   */
  private takeOverLockAtomic(hostname: string): boolean {
    try {
      try {
        SafeFsExecutor.safeUnlinkSync(this.lockPath, { operation: 'ResumeQueue.takeOverLockAtomic stale-rename heal' });
      } catch {
        // @silent-fallback-ok — already gone (another racer removed it) is fine;
        // the 'wx' create below is the actual mutual-exclusion gate.
      }
      const fd = fs.openSync(this.lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      // @silent-fallback-ok — EEXIST (lost the race) or any error ⇒ we did NOT
      // take the lock; caller disables and re-evaluates. The safe direction.
      return false;
    }
  }

  /**
   * D2 — guard-posture self-report. `enabled:false` whenever the queue is
   * disabled (e.g. an un-healable foreign-host lock), so the guard-posture
   * inventory classifies a disabled revival queue as `off-runtime-divergent`
   * (config on, runtime off → the alerting class) instead of it being visible
   * only as a `disabled:` string. ALWAYS reflects live runtime state — NOT
   * dryRun-gated (a disabled guard must be loud even during a dryRun soak).
   */
  guardStatus(): { enabled: boolean; dryRun: boolean; reason?: string } {
    return {
      enabled: this.cfg.enabled && !this.disabledReason,
      dryRun: this.cfg.dryRun,
      reason: this.disabledReason ?? undefined,
    };
  }

  private load(): void {
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.statePath, 'utf-8');
    } catch {
      raw = null; // first run — empty queue
    }
    if (raw == null) return;
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        this.state = {
          version: 1,
          paused: !!parsed.paused,
          pausedAt: parsed.pausedAt,
          pauseReason: parsed.pauseReason,
          entries: parsed.entries,
          tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
        };
        return;
      }
      throw new Error('unrecognized shape');
    } catch (err) {
      // Corrupt file: sidecar-preserve, start empty, surface loudly — never a
      // silent reset, never a crash (R2.3).
      const sidecar = path.join(
        path.dirname(this.statePath),
        `resume-queue.corrupt-${this.now().toString(36)}.json`,
      );
      try {
        fs.copyFileSync(this.statePath, sidecar);
      } catch {
        /* keep going — the original may be unreadable */
      }
      this.state = { version: 1, paused: false, entries: [], tombstones: [] };
      this.audit({ event: 'state-corrupt', sidecar, error: err instanceof Error ? err.message : String(err) });
      this.deps.raiseAggregated?.(
        'state-corrupt',
        `resume-queue.json was unreadable and has been preserved at ${sidecar}; the queue restarted empty. ` +
        `Losing the resurrection ledger in this rare path is accepted and surfaced.`,
      );
    }
  }

  /** Crash-durable persist: temp → fsync temp → rename → fsync parent dir. */
  private persist(): void {
    const dir = path.dirname(this.statePath);
    const tmp = path.join(dir, `.resume-queue.tmp-${process.pid}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(this.state, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.statePath);
      try {
        const dirFd = fs.openSync(dir, 'r');
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        /* dir-fsync unsupported on some platforms — rename already landed */
      }
    } catch (err) {
      this.audit({ event: 'persist-failed', error: err instanceof Error ? err.message : String(err) });
    }
  }

  private audit(event: Record<string, unknown>): void {
    try {
      this.deps.audit?.({ ts: new Date(this.now()).toISOString(), ...event });
    } catch {
      /* @silent-fallback-ok — the audit sink never endangers the queue; the
         decision the audit row describes still happened and is persisted. */
    }
  }

  /** Boot reconciliation half 1 (R2.4): `starting` found at load = failed attempt. */
  private reconcileStartingEntries(): void {
    let changed = false;
    for (const entry of this.state.entries) {
      if (entry.status === 'starting') {
        entry.attempts += 1;
        entry.status = entry.attempts >= this.cfg.maxAttempts ? 'gave-up:max-attempts' : 'queued';
        entry.nextAttemptAt = undefined;
        this.audit({ event: 'boot-reconcile-starting', id: entry.id, attempts: entry.attempts, status: entry.status });
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Boot reconciliation half 2 (R2.4): recent reap-log midWork terminal
   * autonomous entries with no queue entry AND no tombstone are re-enqueued —
   * closing the crash window where an enqueue's persist was lost. The caller
   * supplies reconstruction (session records, resume map) — a candidate that
   * cannot be reconstructed is skipped (the next re-reap recreates it).
   */
  reconcileFromReapLog(candidates: ResumeCandidateInput[]): number {
    let enqueued = 0;
    for (const candidate of candidates) {
      const stableKey = this.stableKeyFor(candidate);
      const known =
        this.state.entries.some((e) => e.stableKey === stableKey) ||
        this.state.tombstones.some((t) => t.stableKey === stableKey);
      if (known) continue;
      const decision = this.considerEnqueue(candidate, { source: 'boot-reconcile' });
      if (decision.enqueued) enqueued++;
    }
    return enqueued;
  }

  private stableKeyFor(input: { topicId?: number | null; jobSlug?: string; tmuxSession: string }): string {
    if (input.topicId != null) return `topic:${input.topicId}`;
    if (input.jobSlug) return `job:${input.jobSlug}`;
    return `tmux:${input.tmuxSession}`;
  }

  /**
   * The enqueue decision (R2.2 + R2.3 + R2.9 resurrection cap). Audited on
   * every outcome. In dry-run the entry is still durably enqueued (the soak's
   * observable), but nothing downstream spawns or claims a resume.
   */
  considerEnqueue(input: ResumeCandidateInput, opts?: { source?: string }): EnqueueDecision {
    if (this.disabledReason) return { enqueued: false, why: 'queue-disabled' };
    if (!this.cfg.enabled) return { enqueued: false, why: 'queue-off' };

    const verdict = classifyEligibility(input, this.cfg);
    if (!verdict.eligible) {
      this.audit({ event: 'enqueue-skipped', why: verdict.why, session: input.sessionName, source: opts?.source });
      return { enqueued: false, why: verdict.why };
    }

    const stableKey = this.stableKeyFor(input);

    // Dedupe on stable identity: one open entry per topic/job/session.
    const open = this.state.entries.find(
      (e) => e.stableKey === stableKey && (e.status === 'queued' || e.status === 'starting'),
    );
    if (open) {
      this.audit({ event: 'enqueue-skipped', why: 'duplicate-open-entry', stableKey, source: opts?.source });
      return { enqueued: false, why: 'duplicate-open-entry' };
    }

    // Resurrection cap (R2.9): a re-reap AFTER a successful resume within the
    // window increments the ledger; at the cap the enqueue is refused LOUDLY —
    // the most diagnostic event this feature produces (P14).
    const tombstone = this.tombstoneFor(stableKey);
    if (tombstone?.lastResumeAt) {
      const windowFresh = this.now() - Date.parse(tombstone.windowStartAt) < RESURRECTION_WINDOW_MS;
      if (!windowFresh) {
        // The prior resume is outside the 24h window — stale history, not a
        // kill-resume-kill loop. Reset the ledger; this re-reap starts fresh.
        tombstone.resurrections = 0;
        tombstone.windowStartAt = new Date(this.now()).toISOString();
      } else {
        tombstone.resurrections += 1;
      }
      if (windowFresh && tombstone.resurrections >= this.cfg.maxResurrections) {
        this.persist();
        this.audit({ event: 'resurrection-cap', stableKey, resurrections: tombstone.resurrections });
        this.deps.raiseAggregated?.(
          'resurrection-cap',
          `${stableKey} was reaped again after ${tombstone.resurrections} resume(s) in 24h — ` +
          `not resuming it again automatically (something keeps killing it). Message the topic to bring ` +
          `it back, or ask me to retry it.`,
        );
        return { enqueued: false, why: 'resurrection-cap' };
      }
    }

    // Bound (R2.3): overflow drops the oldest LOW-priority entry into the
    // aggregated surface — never silently.
    const openEntries = this.state.entries.filter((e) => e.status === 'queued' || e.status === 'starting');
    if (openEntries.length >= this.cfg.maxQueueSize) {
      const dropOrder: ResumePriorityClass[] = ['other', 'job', 'interactive'];
      let dropped: ResumeQueueEntry | undefined;
      for (const cls of dropOrder) {
        dropped = openEntries.filter((e) => e.priorityClass === cls).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))[0];
        if (dropped) break;
      }
      if (dropped) {
        dropped.status = 'gave-up:overflow';
        this.audit({ event: 'overflow-drop', id: dropped.id, stableKey: dropped.stableKey });
        this.deps.raiseAggregated?.(
          'overflow',
          `The resume queue hit its cap (${this.cfg.maxQueueSize}); the oldest low-priority entry ` +
          `(${dropped.sessionName}) was dropped.`,
        );
      }
    }

    const entry: ResumeQueueEntry = {
      id: `rq-${this.now().toString(36)}-${(this.seq++).toString(36)}`,
      queuedAt: new Date(this.now()).toISOString(),
      stableKey,
      sessionName: input.sessionName,
      tmuxSession: input.tmuxSession,
      ...(input.topicId != null ? { topicId: input.topicId } : {}),
      ...(input.resumeUuid ? { resumeUuid: input.resumeUuid } : {}),
      ...(input.jobSlug ? { jobSlug: input.jobSlug } : {}),
      cwd: input.cwd,
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
      priorityClass: input.topicId != null ? 'interactive' : input.jobSlug ? 'job' : 'other',
      reason: input.reason.slice(0, REASON_CAP),
      workEvidence: clampWorkEvidence(input.workEvidence),
      attempts: 0,
      status: 'queued',
    };
    this.state.entries.push(entry);
    this.persist();
    this.audit({
      event: 'enqueued',
      id: entry.id,
      stableKey,
      priorityClass: entry.priorityClass,
      midWorkEvidence: entry.workEvidence,
      dryRun: this.cfg.dryRun,
      source: opts?.source,
    });
    return { enqueued: true, entry };
  }

  private tombstoneFor(stableKey: string): ResurrectionTombstone | undefined {
    return this.state.tombstones.find((t) => t.stableKey === stableKey);
  }

  /** Record a successful resume (drainer, after spawn verification). */
  recordResumeSuccess(stableKey: string): void {
    let tombstone = this.tombstoneFor(stableKey);
    if (!tombstone) {
      tombstone = {
        stableKey,
        resurrections: 0,
        windowStartAt: new Date(this.now()).toISOString(),
      };
      this.state.tombstones.push(tombstone);
    }
    tombstone.lastResumeAt = new Date(this.now()).toISOString();
    this.persist();
  }

  /** Ordered open entries: interactive → job → other, FIFO inside each (R2.5). */
  nextCandidates(): ResumeQueueEntry[] {
    const order: Record<ResumePriorityClass, number> = { interactive: 0, job: 1, other: 2 };
    return this.state.entries
      .filter((e) => e.status === 'queued')
      .sort(
        (a, b) =>
          order[a.priorityClass] - order[b.priorityClass] || a.queuedAt.localeCompare(b.queuedAt),
      );
  }

  list(): ResumeQueueEntry[] {
    return [...this.state.entries];
  }

  get(id: string): ResumeQueueEntry | undefined {
    return this.state.entries.find((e) => e.id === id);
  }

  /** State-transition helpers (each persists + audits the TRANSITION). */
  transition(id: string, status: ResumeEntryStatus, extra?: Partial<ResumeQueueEntry>): boolean {
    const entry = this.get(id);
    if (!entry) return false;
    const from = entry.status;
    entry.status = status;
    if (extra) Object.assign(entry, extra);
    this.persist();
    this.audit({ event: 'transition', id, from, to: status, attempts: entry.attempts });
    return true;
  }

  /** Operator/API cancel (an explicit per-topic stop cancels that topic's entries — R2.7). */
  cancel(id: string): boolean {
    const entry = this.get(id);
    if (!entry || (entry.status !== 'queued' && entry.status !== 'starting')) return false;
    return this.transition(id, 'cancelled');
  }

  cancelByTopic(topicId: number): number {
    let n = 0;
    for (const entry of this.state.entries) {
      if (entry.topicId === topicId && (entry.status === 'queued' || entry.status === 'starting')) {
        this.transition(entry.id, 'cancelled');
        n++;
      }
    }
    return n;
  }

  /**
   * Requeue clamps (R2.10): eligible from gave-up:* ONLY — never `cancelled`
   * (an operator stop) and refused while paused (callers enforce the 409).
   * Resets attempts and RE-ANCHORS the TTL clock while preserving the original
   * queuedAt for the R2.6 operator-stop / job-ran-since checks. Requeueing a
   * gave-up:resurrection-cap entry grants exactly ONE audited override.
   */
  requeue(id: string): { ok: boolean; why?: string } {
    if (this.state.paused) return { ok: false, why: 'queue-paused' };
    const entry = this.get(id);
    if (!entry) return { ok: false, why: 'not-found' };
    if (!entry.status.startsWith('gave-up:')) return { ok: false, why: 'not-gave-up' };
    if (entry.status === 'gave-up:resurrection-cap') {
      // The requeue itself IS the one audited override (it bypasses the
      // considerEnqueue cap check); the next re-reap re-caps (R2.10).
      this.audit({ event: 'resurrection-override-granted', stableKey: entry.stableKey, id });
    }
    entry.attempts = 0;
    entry.requeuedAt = new Date(this.now()).toISOString();
    entry.nextAttemptAt = undefined;
    entry.pressureStarved = false;
    return this.transition(id, 'queued') ? { ok: true } : { ok: false, why: 'transition-failed' };
  }

  /**
   * Queue-global pause (R2.7): entries keep their states; TTLs freeze.
   *
   * UPGRADE-ON-DELIBERATE-HALT (spec: resume-queue-stale-emergency-pause.md,
   * review rounds 4–5 — codex/gemini): pause is first-writer-wins EXCEPT that a
   * DELIBERATE, non-auto-resumable reason (e.g. `'autonomous stop-all'`) UPGRADES
   * an existing AUTO-RESUMABLE (emergency/sentinel) pause — so an operator's
   * explicit "halt all automation" issued while a stale-emergency pause is active
   * is honored, not silently no-op'd into something the drainer can later
   * auto-clear. The reverse (an emergency stop while a deliberate halt is active)
   * stays a no-op: a deliberate halt is never downgraded into auto-resumable.
   */
  pause(reason: string): void {
    if (this.state.paused) {
      const currentAutoResumable = isAutoResumableEmergencyPauseReason(this.state.pauseReason);
      const incomingAutoResumable = isAutoResumableEmergencyPauseReason(reason);
      // Only upgrade: auto-resumable (current) → deliberate halt (incoming).
      if (currentAutoResumable && !incomingAutoResumable) {
        const priorReason = this.state.pauseReason;
        this.state.pauseReason = reason;
        // pausedAt is NOT advanced — the freeze clock is continuous; only the
        // reason (and thus the auto-resume eligibility) is upgraded.
        this.persist();
        this.audit({ event: 'pause-upgraded', from: priorReason, to: reason });
      }
      return;
    }
    this.state.paused = true;
    this.state.pausedAt = new Date(this.now()).toISOString();
    this.state.pauseReason = reason;
    this.persist();
    this.audit({ event: 'paused', reason });
  }

  /** Explicit unpause lever (R2.7) — accumulates the pause into frozenMs. */
  unpause(): void {
    if (!this.state.paused) return;
    const pausedMs = this.state.pausedAt ? this.now() - Date.parse(this.state.pausedAt) : 0;
    for (const entry of this.state.entries) {
      if (entry.status === 'queued' || entry.status === 'starting') {
        entry.frozenMs = (entry.frozenMs ?? 0) + pausedMs;
      }
    }
    this.state.paused = false;
    this.state.pausedAt = undefined;
    this.state.pauseReason = undefined;
    this.persist();
    this.audit({ event: 'unpaused', pausedMs });
  }

  pauseInfo(): { paused: boolean; pausedAt?: string; reason?: string } {
    return { paused: this.state.paused, pausedAt: this.state.pausedAt, reason: this.state.pauseReason };
  }

  /**
   * TTL sweep (R2.9): INCIDENT-AGE semantics — wall clock since
   * max(queuedAt, requeuedAt), minus operator-pause freeze, NOT frozen by
   * pressure. Expiries under sustained pressure carry the pressure-starved
   * marker so a day-long overload reads differently from ordinary staleness.
   * No sweep while paused (an operator pause must not silently expire the queue).
   */
  expireTtl(pressureCalm: boolean): ResumeQueueEntry[] {
    if (this.state.paused) return [];
    const expired: ResumeQueueEntry[] = [];
    const ttlMs = this.cfg.entryTtlHours * 3600_000;
    for (const entry of this.state.entries) {
      if (entry.status !== 'queued') continue;
      const anchor = Date.parse(entry.requeuedAt ?? entry.queuedAt);
      const ageMs = this.now() - anchor - (entry.frozenMs ?? 0);
      if (ageMs > ttlMs) {
        entry.pressureStarved = !pressureCalm;
        entry.status = 'gave-up:ttl';
        expired.push(entry);
        this.audit({ event: 'ttl-expired', id: entry.id, pressureStarved: entry.pressureStarved, ageMs });
      }
    }
    if (expired.length > 0) this.persist();
    return expired;
  }

  /** Snapshot for the API surface (R2.10). */
  snapshot(): {
    paused: boolean;
    pauseReason?: string;
    disabled: string | null;
    dryRun: boolean;
    entries: ResumeQueueEntry[];
    tombstones: ResurrectionTombstone[];
  } {
    return {
      paused: this.state.paused,
      pauseReason: this.state.pauseReason,
      disabled: this.disabledReason,
      dryRun: this.cfg.dryRun,
      entries: this.list(),
      tombstones: [...this.state.tombstones],
    };
  }

  /** True when a LIVE (non-dry-run) queued entry exists for this tmux session
   *  — feeds the notifier's "restart is queued" line (R1.2). */
  hasLiveQueuedEntryFor(tmuxSession: string): boolean {
    if (this.cfg.dryRun || this.disabledReason || !this.cfg.enabled) return false;
    return this.state.entries.some(
      (e) => e.tmuxSession === tmuxSession && (e.status === 'queued' || e.status === 'starting'),
    );
  }
}
