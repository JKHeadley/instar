/**
 * ExternalHogKillLedger — the P19 loop brakes of the External-Hog sentinel
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §6).
 *
 * A durable ledger of kills that STOPS the sentinel from fighting a respawning process
 * forever (the #863 reaper-kill-loop shape: 17,503 identical requests). Two brakes, both
 * pure state machines here (the durable persistence + the actual kill are the caller's):
 *
 *  1. RESPAWN BREAKER — after K kills of the same respawn-surviving signature within a
 *     rolling window, STOP killing it and surface ONE degradation ("keeps respawning — may
 *     be managed"). The key is the command-hash + a stable discriminator (`--user-data-dir`);
 *     when only a VOLATILE discriminator is available (round-9), the anti-loop guarantee
 *     falls back to a CLASS-level breaker (a per-volatile-key breaker could never trip), so
 *     the loop is still bounded. The breaker shields same-key hogs from further KILL only —
 *     NEVER from the §4 observability floor.
 *
 *  2. IN-FLIGHT SET — a size-capped set of (pid, start-time) SIGTERM'd-but-not-yet-dead
 *     targets, so a process seen again before it dies is not re-killed each scan. Eviction is
 *     tied to CONFIRMED exit OR `inFlightKillTtlMs` (~3×sigtermGrace, NOT 2× — which could
 *     SIGKILL a mid-write language server early).
 */

export interface KillRecord {
  /** The respawn-surviving ledger key (command-hash + stable discriminator). */
  readonly key: string;
  /** The allowlist class id (used for the class-level fallback breaker). */
  readonly classId: string;
  /** Monotonic-ish wall timestamp of the kill (ms). */
  readonly atMs: number;
}

export interface KillLedgerState {
  readonly records: readonly KillRecord[];
}

export const EMPTY_KILL_LEDGER: KillLedgerState = { records: [] };

export interface BreakerOpts {
  readonly nowMs: number;
  /** Rolling window (ms) the K-count is measured over (default 1h). */
  readonly windowMs: number;
  /** K — kills of the same key within the window before the breaker trips (default 3). */
  readonly maxPerWindow: number;
  /** True when the ledger key is a VOLATILE fallback (no stable discriminator) — count by
   *  CLASS instead of key, since a per-volatile-key count could never accumulate. */
  readonly keyIsVolatile: boolean;
}

/**
 * Append a kill and PRUNE records older than the retention bound (so the durable ledger can
 * never grow without limit). Returns a NEW state (pure).
 *
 * CALLER PRECONDITION: `retentionMs >= isBreakerTripped(...).windowMs`. `recordKill` cannot
 * see the breaker window, so if retention were shorter it would prune kills the breaker still
 * needs and silently UNDERCOUNT (a spurious not-tripped). The config wires retention ≥ window;
 * a test asserts the breaker still trips at K when retention == window.
 */
export function recordKill(state: KillLedgerState, record: KillRecord, retentionMs: number, nowMs: number): KillLedgerState {
  const cutoff = nowMs - retentionMs;
  const kept = state.records.filter((r) => r.atMs >= cutoff);
  return { records: [...kept, record] };
}

/**
 * Is the breaker TRIPPED for this (key, classId) — i.e. should the sentinel STOP killing it?
 * True when ≥ `maxPerWindow` kills of the same signature fall within the rolling window. For a
 * volatile key, the signature is the CLASS; otherwise it is the exact key.
 */
export function isBreakerTripped(state: KillLedgerState, key: string, classId: string, opts: BreakerOpts): boolean {
  // Fail toward the SAFE direction for a loop brake: if we can't reason about the window,
  // TRIP (stop killing) rather than risk an unbounded loop. This must reject not only
  // NON-FINITE inputs but also a NON-POSITIVE `windowMs` (≤ 0 is finite but nonsensical: it
  // would make `since = now - windowMs >= now`, so every real record falls before `since`, the
  // count collapses to ~0, and the breaker would spuriously report NOT-tripped — the dangerous
  // unbounded-loop direction). `maxPerWindow ≤ 0` is safe either way (trips always) but is
  // treated as unreasoned too. (round-11 — second-pass reviewer.)
  if (
    !Number.isFinite(opts.nowMs) ||
    !(Number.isFinite(opts.windowMs) && opts.windowMs > 0) ||
    !(Number.isFinite(opts.maxPerWindow) && opts.maxPerWindow > 0)
  ) {
    return true;
  }
  const since = opts.nowMs - opts.windowMs;
  const count = state.records.filter((r) => {
    if (r.atMs < since) return false;
    return opts.keyIsVolatile ? r.classId === classId : r.key === key;
  }).length;
  return count >= opts.maxPerWindow;
}

/** Count of in-window kills for a signature (for the degradation message / observability). */
export function killCountInWindow(state: KillLedgerState, key: string, classId: string, opts: BreakerOpts): number {
  const since = opts.nowMs - opts.windowMs;
  return state.records.filter((r) => r.atMs >= since && (opts.keyIsVolatile ? r.classId === classId : r.key === key)).length;
}

// ---- In-flight kill set ----

export interface InFlightKill {
  readonly pid: number;
  readonly startTime: string;
  /** When SIGTERM was sent (ms). */
  readonly sigtermAtMs: number;
}

/**
 * Should an in-flight entry be EVICTED? Yes on CONFIRMED exit, or once `ttlMs` has elapsed
 * since SIGTERM (a ceiling comfortably longer than sigtermGrace so a mid-write LS is not
 * re-entered early). A non-finite `nowMs`/`ttlMs` evicts (fail toward not leaking the set).
 */
export function shouldEvictInFlight(entry: InFlightKill, nowMs: number, ttlMs: number, confirmedGone: boolean): boolean {
  if (confirmedGone) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || !Number.isFinite(entry.sigtermAtMs)) return true;
  return nowMs - entry.sigtermAtMs >= ttlMs;
}

/** Is this pid+start-time already in-flight (so we must NOT re-kill it this scan)? */
export function isInFlight(set: readonly InFlightKill[], pid: number, startTime: string): boolean {
  return set.some((e) => e.pid === pid && e.startTime === startTime);
}
