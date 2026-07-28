/**
 * hostSpawnSemaphore — P1 of the SIMPLE fork-bomb prevention design.
 *
 * Spec: docs/specs/forkbomb-prevention-simple.md (§P1, §P3, §D-CAP).
 * Source postmortem: the-portal/docs/postmortems/2026-06-20-echo-instar-forkbomb-oom.md.
 *
 * THE PRIMARY CONTROL. A single host-local COUNTING SEMAPHORE that bounds how
 * many LLM subprocesses ("claude -p" / "codex exec" / …) run AT ONCE across
 * EVERY compliant Instar agent + server instance on this host. The 2026-06-20
 * incident fork-bombed a 128GB macOS host into OOM twice (~230-289 concurrent
 * `claude -p` ≈ 90-115GB) because `evaluate()` spawned one subprocess per call
 * with ZERO concurrency control and CoherenceGate fans ~10 reviewers in
 * parallel per message. This bounds that.
 *
 * MECHANISM — a holder-SET model (NOT decrement/increment counter math):
 *   A host-local file (`~/.instar/host-spawn-holders.json`, NOT a synced
 *   volume), guarded by an exclusive O_CREAT|O_EXCL lock (the in-tree
 *   ProjectRoundLock pattern). The cap is enforced by COUNTING LIVE holder
 *   records — never by mutating a shared integer:
 *     - acquire(id): under the lock, prune dead holders, and if
 *       liveHolders < cap append `{id, pid, hostname, heartbeat}` (atomic
 *       temp+rename) → true; else false.
 *     - release(id): under the lock, remove THIS id.
 *   Crash-safe by construction: a double-release is a no-op (id already gone),
 *   a pid-reuse can't steal a slot (unique id, not pid), a partial write is
 *   discarded (temp+rename), a crashed holder is reclaimed by prune-dead
 *   (pid not alive AND heartbeat stale, on THIS host only).
 *
 * HOST-LOCAL-LOCK CONTRACT (mirrors ResumeQueue.ts, the 2026-06-15 lesson):
 *   - A FOREIGN-hostname holder is NEVER pruned/reclaimed (refuse-loud — a
 *     pid check is meaningless cross-host on a shared volume).
 *   - A `df -P` host-local-disk confirmation gates reclaim (fail-closed: if we
 *     cannot positively confirm the holders file is on a local disk, we NEVER
 *     prune a holder — we only ever decline to reclaim, never decline to bound).
 *
 * BOUNDED INGRESS (P3) lives in the wrapper (SpawnCapIntelligenceProvider) via
 * poll-retry against `acquire()` — this module is the pure counting primitive.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  atomicWriteFileSync,
  classifyDfSourceLocal,
  legacyPidDeathLockReclaim,
  probeDfHostLocal,
  pruneHolders,
  releaseLock,
  tryTakeLockOnce,
  type ReclaimContext,
} from './hostSemaphoreCore.js';
import { isAlive } from './ProjectRoundLock.js';

// Re-export: classifyDfSourceLocal moved to hostSemaphoreCore (the §2.1
// extraction) but remains part of this module's public export surface.
export { classifyDfSourceLocal };

/** One live holder of a spawn slot. */
/**
 * The two reservation lanes (F5, docs/specs/spawn-cap-interactive-priority.md).
 * `interactive` = a synchronous, user-blocking call (the operator-facing tone gate);
 * `background` = everything else (sentinels/sweeps/reflectors). A holder with no
 * lane, or an unrecognized value, is classified `background` (equality, never parse —
 * a garbage value can never consume the protected interactive reserve).
 */
export type SpawnLane = 'interactive' | 'background';

export interface SpawnHolder {
  /** Unique per-acquire id (NOT the pid — pid-reuse must not steal a slot). */
  id: string;
  pid: number;
  hostname: string;
  /** ms epoch of the last heartbeat (acquire time, refreshed by long holders). */
  heartbeat: number;
  /**
   * F5 reservation lane (OPTIONAL — never part of isWellFormedHolder, so a record
   * with a missing/garbage lane is NEVER dropped; it is counted as `background`).
   * Written only when interactive-priority is enabled; absent otherwise (the
   * disabled state writes a byte-identical holder file).
   */
  lane?: SpawnLane;
}

/**
 * F5 symmetric reservation knobs. `Ri` slots are reserved for the interactive lane,
 * `Rb` for background, both WITHIN the existing total cap `N` (never raising it).
 * Clamped so `0 ≤ Ri`, `0 ≤ Rb`, `Ri + Rb ≤ N − 1` (≥1 always-contended slot).
 */
export interface InteractivePriorityConfig {
  enabled: boolean;
  /** interactive reserve (clamped to [0, N-1]). */
  ri: number;
  /** background reserve (clamped to [0, N-1-Ri]). */
  rb: number;
}

/**
 * Resolve+clamp `Ri`/`Rb` against the effective cap `N`. Uses `Number.isFinite` and
 * `>= 0` (NOT the cap's `> 0`) so a legitimate 0 is preserved; NaN/negative fall to
 * the default. Interactive reserve is honored first (documented priority), background
 * takes the remainder — guaranteeing both bands and ≥1 contended slot for any N ≥ 1.
 */
export function clampInteractiveReserves(
  cap: number,
  ri: number | undefined,
  rb: number | undefined,
): { ri: number; rb: number } {
  const n = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 8;
  const riReq = Number.isFinite(ri) && (ri as number) >= 0 ? Math.floor(ri as number) : 2;
  const rbReq = Number.isFinite(rb) && (rb as number) >= 0 ? Math.floor(rb as number) : 2;
  const clampedRi = Math.max(0, Math.min(riReq, n - 1));
  const clampedRb = Math.max(0, Math.min(rbReq, n - 1 - clampedRi));
  return { ri: clampedRi, rb: clampedRb };
}

interface HoldersFile {
  version: 1;
  holders: SpawnHolder[];
}

/** Heartbeat staleness window. A holder is reclaimed only when its pid is dead
 * (PRIMARY signal) AND its heartbeat is older than this (SECONDARY signal) AND
 * the holders file is df-confirmed host-local — an AND conjunction (see the
 * authoritative ReclaimPolicy contract in hostSemaphoreCore.ts). Kept long
 * (a slow `claude -p` cold-start + run can legitimately exceed a minute); a
 * live-pid holder is NEVER reclaimed regardless of heartbeat. */
export const HOLDER_STALE_MS = 5 * 60_000;

/**
 * FD1 (from ResumeQueue) — is `p` on a HOST-LOCAL filesystem? FAIL-CLOSED:
 * anything we cannot positively confirm as local returns false, so a holder on
 * a genuine shared/network volume is NEVER reclaimed (the two-hosts-one-volume
 * corruption the host-lock invariant protects against). `df -P` device-column
 * classification — re-implemented here (not imported from monitoring/) so
 * core/ never depends on monitoring/.
 */
export function isPathHostLocalDefault(p: string): boolean {
  // Delegates to the extracted core probe (lint-allow-sync-spawn there: a
  // bounded 3s one-shot, run ONCE per process and then MEMOIZED by
  // HostSpawnSemaphore._fsLocalCache — never on the hot acquire() fan-out
  // path). FAIL-CLOSED: a failed probe reads as not-local (never reclaim on
  // doubt). NOTE: the memoize-a-failed-probe behavior is a §1.2-identified
  // defect (a df timeout under load disables reclaim for the process
  // lifetime); fixing it is part of the tracked spawn-lane back-port — the
  // extraction preserves behavior byte-for-byte.
  return probeDfHostLocal(p);
}

export interface HostSpawnSemaphoreDeps {
  /** Absolute path to the holders file. Default `~/.instar/host-spawn-holders.json`. */
  holdersPath?: string;
  /** Concurrent-spawn cap. Default resolved by `resolveSpawnCap()`. */
  cap?: number;
  now?: () => number;
  hostname?: () => string;
  /** pid liveness probe (tests override). */
  pidAlive?: (pid: number) => boolean;
  /** Host-local FS probe (tests override; default `isPathHostLocalDefault`). */
  isPathHostLocal?: (p: string) => boolean;
  /** Unique-id generator (tests override for determinism). */
  genId?: () => string;
  /**
   * F5 interactive-priority reservation. When `enabled:false` (or absent), `acquire`
   * ignores the lane and is byte-identical to the all-or-nothing cap (no `lane` is
   * written to holders). When enabled, the symmetric reserve in §C applies.
   */
  interactivePriority?: InteractivePriorityConfig;
}

/**
 * Resolve the concurrent-spawn cap. Precedence (D-CAP):
 *   INSTAR_HOST_SPAWN_MAX env  >  config intelligence.spawnCap.maxConcurrent  >  8.
 * A safety FLOOR — read with a plain `??` default, NEVER resolveDevAgentGate
 * (it is ON by default, ships never-dark). A non-positive / non-finite value
 * is ignored (falls through to the next source) so a typo can't disable the cap.
 */
export function resolveSpawnCap(configCap?: number, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = env['INSTAR_HOST_SPAWN_MAX'];
  if (fromEnv !== undefined) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  if (typeof configCap === 'number' && Number.isFinite(configCap) && configCap > 0) {
    return Math.floor(configCap);
  }
  return 8;
}

/**
 * Resolve the bounded-acquire poll budget in ms (P3). Precedence (D-CAP):
 *   INSTAR_SPAWN_ACQUIRE_MS env  >  config intelligence.spawnCap.acquireMs  >  5000.
 * Read with a plain `??` default (safety floor, never resolveDevAgentGate).
 */
export function resolveSpawnAcquireMs(configMs?: number, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = env['INSTAR_SPAWN_ACQUIRE_MS'];
  if (fromEnv !== undefined) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  if (typeof configMs === 'number' && Number.isFinite(configMs) && configMs >= 0) {
    return Math.floor(configMs);
  }
  return 5000;
}

/**
 * Resolve the concurrent-pollers ceiling (P3). Precedence (D-CAP):
 *   INSTAR_SPAWN_WAITERS_MAX env  >  config intelligence.spawnCap.waitersMax  >  64.
 */
export function resolveSpawnWaitersMax(configMax?: number, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = env['INSTAR_SPAWN_WAITERS_MAX'];
  if (fromEnv !== undefined) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  if (typeof configMax === 'number' && Number.isFinite(configMax) && configMax > 0) {
    return Math.floor(configMax);
  }
  return 64;
}

export interface SpawnSemaphoreStatus {
  cap: number;
  /** Live holders after pruning, this host + foreign. */
  liveHolders: number;
  /** Holders whose hostname is THIS host. */
  localHolders: number;
  /** Holders whose hostname is a DIFFERENT host (never reclaimed). */
  foreignHolders: number;
  holdersPath: string;
  /** F5: interactive-priority reservation state. `enabled:false` ⇒ ri/rb 0 and the
   * lane counts are over whatever lanes the holders carry (all background when off). */
  interactivePriority: { enabled: boolean; ri: number; rb: number };
  /** Live holders classified `interactive` (equality; everything else is background). */
  liveInteractive: number;
  liveBackground: number;
}

/**
 * Host-wide counting semaphore over LLM-subprocess spawns. One instance per
 * process is fine — the cross-process coordination is the file + flock, not
 * the object. Stateless beyond the file.
 */
export class HostSpawnSemaphore {
  private readonly holdersPath: string;
  private readonly cap: number;
  private readonly now: () => number;
  private readonly host: string;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly isPathHostLocal: (p: string) => boolean;
  private readonly genId: () => string;
  /** F5 reservation config (resolved+clamped once at construction). */
  private readonly priority: { enabled: boolean; ri: number; rb: number };
  /** Memoized host-local determination (a fixed path's FS type can't change at
   * runtime; the `df -P` probe is expensive + synchronous, so it runs ONCE per
   * instance — never per acquire() on the hot fan-out path). */
  private _fsLocalCache: boolean | undefined;

  constructor(deps: HostSpawnSemaphoreDeps = {}) {
    this.holdersPath = deps.holdersPath ?? defaultHoldersPath();
    this.cap = deps.cap ?? resolveSpawnCap();
    this.now = deps.now ?? (() => Date.now());
    this.host = (deps.hostname ?? (() => os.hostname()))();
    this.pidAlive = deps.pidAlive ?? isAlive;
    this.isPathHostLocal = deps.isPathHostLocal ?? isPathHostLocalDefault;
    this.genId =
      deps.genId ??
      (() => `${this.host}:${process.pid}:${this.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`);
    const ip = deps.interactivePriority;
    if (ip && ip.enabled === true) {
      const { ri, rb } = clampInteractiveReserves(this.cap, ip.ri, ip.rb);
      this.priority = { enabled: true, ri, rb };
    } else {
      this.priority = { enabled: false, ri: 0, rb: 0 };
    }
  }

  getCap(): number {
    return this.cap;
  }

  /** F5: is interactive-priority reservation active on this instance? The wrapper
   * reads this so its lane-aware ingress stays byte-identical when the feature is off. */
  interactivePriorityEnabled(): boolean {
    return this.priority.enabled;
  }

  /**
   * Try to take a slot under id `id`. Returns true if a slot was appended
   * (liveHolders < cap after pruning), false if the host is at the cap.
   * Holds the exclusive flock for the whole read-prune-decide-write window.
   */
  acquire(id: string, lane: SpawnLane = 'background'): boolean {
    return this.withLock(() => {
      const file = this.readHolders();
      const live = this.pruneDead(file.holders);
      // The OOM floor — UNCONDITIONAL first predicate of every lane. Never raised by
      // the reservation; the reserve only SUBDIVIDES within `cap`.
      if (live.length >= this.cap) {
        this.writeHolders({ version: 1, holders: live });
        return false;
      }
      // F5 symmetric reservation (over the SAME pruned `live` set, this critical
      // section). Counts are equality-based: a missing/garbage lane → background, so a
      // malformed holder can never consume the protected interactive reserve.
      if (this.priority.enabled) {
        const liveInteractive = live.filter((h) => h.lane === 'interactive').length;
        const liveBackground = live.length - liveInteractive;
        if (lane === 'interactive') {
          if (liveInteractive >= this.cap - this.priority.rb) {
            this.writeHolders({ version: 1, holders: live });
            return false;
          }
        } else if (liveBackground >= this.cap - this.priority.ri) {
          this.writeHolders({ version: 1, holders: live });
          return false;
        }
      }
      // Crash-safe: an id already present (a retry that already landed) is a
      // no-op-append, not a duplicate slot.
      if (!live.some((h) => h.id === id)) {
        const holder: SpawnHolder = { id, pid: process.pid, hostname: this.host, heartbeat: this.now() };
        // Write `lane` ONLY when the feature is on — disabled state keeps the holder
        // file byte-identical to today (clean rollback / mixed-version safety).
        if (this.priority.enabled) holder.lane = lane;
        live.push(holder);
      }
      this.writeHolders({ version: 1, holders: live });
      return true;
    }, /* fallbackOnLockFail */ false);
  }

  /** Release the slot held under `id`. A double-release / unknown id is a no-op. */
  release(id: string): void {
    this.withLock(() => {
      const file = this.readHolders();
      const remaining = file.holders.filter((h) => h.id !== id);
      // Opportunistically GC dead holders on release too (cheap, keeps the file small).
      const live = this.pruneDead(remaining);
      this.writeHolders({ version: 1, holders: live });
      return undefined;
    }, /* fallbackOnLockFail */ undefined);
  }

  /** Refresh a long-held slot's heartbeat so a slow legit spawn is never reclaimed. */
  heartbeat(id: string): void {
    this.withLock(() => {
      const file = this.readHolders();
      let changed = false;
      for (const h of file.holders) {
        if (h.id === id) {
          h.heartbeat = this.now();
          changed = true;
        }
      }
      if (changed) this.writeHolders(file);
      return undefined;
    }, /* fallbackOnLockFail */ undefined);
  }

  /** Read-only status (count of live holders after a prune). Best-effort: never throws. */
  status(): SpawnSemaphoreStatus {
    let live: SpawnHolder[] = [];
    try {
      live = this.withLock(() => {
        const file = this.readHolders();
        const pruned = this.pruneDead(file.holders);
        this.writeHolders({ version: 1, holders: pruned });
        return pruned;
      }, /* fallbackOnLockFail */ this.readHolders().holders);
    } catch {
      // @silent-fallback-ok: status is observability — a read error reports
      // zero holders rather than throwing into the /spawn-limiter route.
      live = [];
    }
    const localHolders = live.filter((h) => h.hostname === this.host).length;
    const liveInteractive = live.filter((h) => h.lane === 'interactive').length;
    return {
      cap: this.cap,
      liveHolders: live.length,
      localHolders,
      foreignHolders: live.length - localHolders,
      holdersPath: this.holdersPath,
      interactivePriority: { ...this.priority },
      liveInteractive,
      liveBackground: live.length - liveInteractive,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Prune dead holders. A holder is reclaimable ONLY if:
   *   - it is on THIS host (a foreign-hostname holder is NEVER reclaimed —
   *     refuse-loud — the cross-host shared-volume hazard), AND
   *   - its pid is no longer alive (PRIMARY signal), AND
   *   - its heartbeat is stale past HOLDER_STALE_MS (SECONDARY signal — a slow
   *     spawn whose pid is alive is NEVER reclaimed regardless of heartbeat).
   * AND a `df -P` host-local confirmation gates ALL reclaim (fail-closed: if we
   * cannot confirm the holders file is on a local disk, we keep ALL holders —
   * over-counting is the safe direction for a cap; it never under-bounds).
   */
  private pruneDead(holders: SpawnHolder[]): SpawnHolder[] {
    if (this._fsLocalCache === undefined) {
      this._fsLocalCache = this.isPathHostLocal(path.dirname(this.holdersPath));
    }
    const ctx: ReclaimContext = {
      nowMs: this.now(),
      hostname: this.host,
      pidAlive: this.pidAlive,
      dfLocal: this._fsLocalCache,
    };
    // The SPAWN-lane ReclaimPolicy (see the contract in hostSemaphoreCore.ts):
    // reclaim only when df-confirmed local AND this host AND pid dead AND
    // heartbeat stale — the AND conjunction; a foreign-hostname holder is
    // NEVER reclaimed, and when df can't confirm local, NOTHING is reclaimed
    // (fail-closed; over-counting is the safe direction for the OOM floor).
    return pruneHolders<SpawnHolder>(
      holders,
      isWellFormedHolder,
      (h, c) =>
        c.dfLocal &&
        h.hostname === c.hostname &&
        !c.pidAlive(h.pid) &&
        c.nowMs - h.heartbeat >= HOLDER_STALE_MS,
      ctx,
    );
  }

  private readHolders(): HoldersFile {
    try {
      const raw = fs.readFileSync(this.holdersPath, 'utf-8');
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.holders)) {
        return { version: 1, holders: [] };
      }
      return { version: 1, holders: obj.holders.filter(isWellFormedHolder) };
    } catch {
      // @silent-fallback-ok: a missing/corrupt holders file is an EMPTY set —
      // the safe direction is to bound from zero, never to crash the spawn path.
      return { version: 1, holders: [] };
    }
  }

  private writeHolders(file: HoldersFile): void {
    this.ensureDir();
    // Extracted atomic temp+rename write (byte-identical body — the golden
    // test pins the on-disk format).
    atomicWriteFileSync(this.holdersPath, JSON.stringify(file), {
      mode: 0o600,
      operation: 'HostSpawnSemaphore.writeHolders',
    });
  }

  /**
   * Run `fn` while holding the exclusive O_CREAT|O_EXCL lock on `<holdersPath>.lock`.
   * On a lock-contention failure (another process holds it), returns
   * `fallbackOnLockFail` — for `acquire`, fallback=false is the SAFE direction
   * (refuse the slot under contention rather than over-grant past the cap).
   * The lock is short-held (a file read + JSON parse + write) so contention is
   * brief; a crashed lock-holder's stale lock is reclaimed by pid-death.
   */
  private withLock<T>(fn: () => T, fallbackOnLockFail: T): T {
    this.ensureDir();
    const lockPath = `${this.holdersPath}.lock`;
    const deadline = this.now() + 2000; // bounded spin — never block the event loop forever
    // Spin-acquire the lock with a tiny busy-wait; the critical section is sub-ms.
    for (;;) {
      const res = tryTakeLockOnce(lockPath, JSON.stringify({ pid: process.pid, at: this.now() }));
      if (!res.ok) {
        if (res.reason === 'held') {
          // Lock held. SPAWN-lane lock-reclaim policy: reclaim when the
          // recorded holder pid is dead (legacy behavior, preserved verbatim —
          // the test lane deliberately does NOT ride this, §2.1).
          if (legacyPidDeathLockReclaim(lockPath, this.pidAlive)) continue;
          if (this.now() >= deadline) return fallbackOnLockFail; // give up safely
          busyWaitTiny();
          continue;
        }
        // Any other open error — fail to the safe fallback rather than throw.
        return fallbackOnLockFail;
      }
      try {
        return fn();
      } finally {
        releaseLock(lockPath, res.fd, 'HostSpawnSemaphore.withLock:release');
      }
    }
  }

  private ensureDir(): void {
    const dir = path.dirname(this.holdersPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/** Default holders file path: `~/.instar/host-spawn-holders.json` (host-local). */
export function defaultHoldersPath(): string {
  return path.join(os.homedir(), '.instar', 'host-spawn-holders.json');
}

function isWellFormedHolder(h: unknown): h is SpawnHolder {
  if (!h || typeof h !== 'object') return false;
  const r = h as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.pid === 'number' &&
    typeof r.hostname === 'string' &&
    typeof r.heartbeat === 'number'
  );
}

/** A sub-millisecond busy-wait so the spin-lock doesn't peg a core. */
function busyWaitTiny(): void {
  const end = Date.now() + 1;
  while (Date.now() < end) {
    /* spin ~1ms */
  }
}

// ── Process-wide singleton ────────────────────────────────────────────
//
// The cross-process coordination is the FILE; this singleton just avoids
// re-resolving deps per call within one process. Config-cap is injected once
// at boot via `configureHostSpawnSemaphore`; absent that, the env/8 default holds.

let _singleton: HostSpawnSemaphore | null = null;
let _configuredCap: number | undefined;
let _configuredAcquireMs: number | undefined;
let _configuredWaitersMax: number | undefined;
let _configuredPriority: InteractivePriorityConfig | undefined;

/** Operator config for the spawn cap (intelligence.spawnCap.*). All optional. */
export interface SpawnCapConfig {
  maxConcurrent?: number;
  acquireMs?: number;
  waitersMax?: number;
  /** F5 interactive-priority reservation (`intelligence.spawnCap.interactivePriority`).
   * `enabled` is resolved by the dev-agent gate at the caller (omitted from
   * ConfigDefaults); when absent here the reservation is OFF (byte-identical). */
  interactivePriority?: InteractivePriorityConfig;
}

/**
 * Inject the config-resolved spawn-cap knobs once at server boot (server.ts).
 * Idempotent: re-resolves the singleton so a later getter sees the configured
 * cap. The env vars still win inside the `resolve*` helpers.
 */
export function configureHostSpawnSemaphore(cfg?: SpawnCapConfig): void {
  _configuredCap = cfg?.maxConcurrent;
  _configuredAcquireMs = cfg?.acquireMs;
  _configuredWaitersMax = cfg?.waitersMax;
  _configuredPriority = cfg?.interactivePriority;
  _singleton = new HostSpawnSemaphore({
    cap: resolveSpawnCap(_configuredCap),
    interactivePriority: _configuredPriority,
  });
}

/** The process-wide semaphore. Lazily constructed with env/config/8 cap. */
export function getHostSpawnSemaphore(): HostSpawnSemaphore {
  if (!_singleton) {
    _singleton = new HostSpawnSemaphore({
      cap: resolveSpawnCap(_configuredCap),
      interactivePriority: _configuredPriority,
    });
  }
  return _singleton;
}

/** Config-aware acquire-budget resolver (env > injected config > 5000). */
export function configuredSpawnAcquireMs(): number {
  return resolveSpawnAcquireMs(_configuredAcquireMs);
}

/** Config-aware waiters-ceiling resolver (env > injected config > 64). */
export function configuredSpawnWaitersMax(): number {
  return resolveSpawnWaitersMax(_configuredWaitersMax);
}

/** Test seam — reset the singleton + injected config. */
export function _resetHostSpawnSemaphoreForTest(): void {
  _singleton = null;
  _configuredCap = undefined;
  _configuredAcquireMs = undefined;
  _configuredWaitersMax = undefined;
}
