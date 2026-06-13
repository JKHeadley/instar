/**
 * WS4.2 (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.2, F7) — Idle vs broken machine
 * empty-state for the pooled sessions view.
 *
 * The blind spot this closes (2026-06-12 live incident): a machine with zero
 * running sessions rendered as NOTHING on the dashboard — indistinguishable
 * from a machine that is broken or unreachable. The operator could not tell
 * "idle but healthy" from "offline" from "was online, now not answering".
 *
 * This module is the HONEST classifier: it derives the explicit per-machine
 * state from REAL inputs only — the registry's `online` flag + last-seen
 * timestamp + whether the pool fan-out's actual HTTP fetch failed (and why).
 * It never fabricates a state and it never invents a "looks fine" default; a
 * machine that genuinely can't be classified surfaces as `unreachable`, the
 * conservative direction (broken, not silently-fine).
 *
 * Three states (spec §WS4.2):
 *   - `online`      → "online — no active sessions" (heartbeat-fresh, just idle)
 *   - `offline`     → "offline since <t>"           (registry knows it is offline)
 *   - `unreachable` → "unreachable (last seen <t>)" (registry thought it was
 *                      online, but the live fetch failed — the pool.failed case)
 *
 * Pure: no I/O, no clock reads beyond the caller-supplied `now`. Both the route
 * (server-side, authoritative) and the dashboard render against its output.
 */

/** The discrete empty-state kind for a machine with zero active sessions. */
export type MachineEmptyStateKind = 'online' | 'offline' | 'unreachable';

/** Per-machine inputs the classifier needs — all from REAL registry/fan-out state. */
export interface MachineStateInput {
  /** Registry liveness: (now − routerReceivedAt) < failoverThreshold. */
  online: boolean;
  /**
   * The fan-out's verdict for this machine, when it was actually queried:
   * `null`     → not in the failed set (fetch succeeded, or never attempted
   *              because the registry already knew it was offline);
   * a reason   → the live HTTP attempt failed with this classified reason
   *              (e.g. 'timeout', 'unreachable', 'error', 'offline',
   *              'no-known-url', 'unauthorized', 'route-missing').
   */
  failedReason: string | null;
  /** Last time the router observed this machine, ISO (router clock). */
  routerReceivedAt?: string;
  /** The machine's self-reported last-heartbeat time, ISO (fallback for display). */
  selfReportedLastSeen?: string;
}

/** Classified per-machine empty-state. */
export interface MachineEmptyState {
  /** Discrete state kind (drives the dashboard styling + copy). */
  kind: MachineEmptyStateKind;
  /** Human-readable phrase, exactly as the spec names it. */
  text: string;
  /** The "last seen" timestamp (ISO) used to render <t>, when known. */
  lastSeen: string | null;
}

/**
 * The `failedReason` values that mean "the machine is genuinely offline /
 * dark" — the registry already knew not to bother (or the attempt proved it).
 * These map to `offline`, NOT `unreachable`: an offline machine is a KNOWN
 * absence, not a surprise non-answer.
 */
const OFFLINE_FAIL_REASONS = new Set(['offline', 'no-known-url']);

/**
 * Format a last-seen ISO timestamp as a relative phrase ("3m ago", "2h ago").
 * Returns 'unknown' when there is no timestamp — never a fabricated time.
 */
export function formatLastSeen(lastSeen: string | null, now: number): string {
  if (!lastSeen) return 'unknown';
  const t = new Date(lastSeen).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const deltaMs = Math.max(0, now - t);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/**
 * Classify ONE machine's empty-state from its real registry + fan-out inputs.
 *
 * Decision boundaries (each side covered by a unit test):
 *   - online && no fetch failure                → `online`   (idle but healthy)
 *   - registry offline, OR a fail reason that
 *     means known-offline                       → `offline`  (known absence)
 *   - everything else (registry thought online
 *     but the live fetch failed)                → `unreachable` (surprise silence)
 *
 * Note: this is only meaningful for a machine with ZERO active sessions — the
 * caller must not assign an empty-state to a machine that has session tiles
 * (a busy machine is already self-evident from its sessions).
 */
export function classifyMachineEmptyState(input: MachineStateInput, now: number): MachineEmptyState {
  const lastSeen = input.routerReceivedAt ?? input.selfReportedLastSeen ?? null;

  // Healthy + idle: heartbeat-fresh AND the live fetch (if attempted) succeeded.
  if (input.online && input.failedReason === null) {
    return { kind: 'online', text: 'online — no active sessions', lastSeen };
  }

  // Known offline: the registry says offline, or the fan-out reason is a
  // known-absence reason (the registry skipped the doomed fetch on purpose).
  if (!input.online || (input.failedReason !== null && OFFLINE_FAIL_REASONS.has(input.failedReason))) {
    const rel = formatLastSeen(lastSeen, now);
    return { kind: 'offline', text: `offline since ${rel}`, lastSeen };
  }

  // Surprise silence: the registry thought this machine was online, but the
  // live fetch failed (timeout / connection refused / error / auth). This is
  // the "was online, now not answering" case — the pool.failed connectivity
  // class. Conservative default for anything not provably idle-or-offline.
  const rel = formatLastSeen(lastSeen, now);
  return { kind: 'unreachable', text: `unreachable (last seen ${rel})`, lastSeen };
}
