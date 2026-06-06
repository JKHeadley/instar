/**
 * OwnerSuspectBreaker — the per-peer circuit breaker behind the SessionRouter's
 * `markOwnerSuspect` hook ("No Unbounded Loops" / P19).
 *
 * The router's forward path already had the SHAPE of a breaker: on delivery
 * retry exhaustion it calls `markOwnerSuspect(owner)` before re-placing the
 * message. But the hook was NEVER WIRED in production (the dep is optional and
 * no implementation existed) — "constructed but inert". The consequence: every
 * session owned by a slow-or-dead peer independently re-paid the full retry
 * tax (3 attempts × backoff ≈ 4.5s+) per message, because `isMachineAlive`
 * reads only capacity heartbeats, which a slow-but-alive peer keeps passing.
 *
 * This class is the wiring's missing half. Half-open TTL semantics:
 *
 *   markSuspect(peer)   — start/extend a suspect window (default 30s). The
 *                         FIRST mark of an episode logs once; an episode
 *                         sustained past signalAfterMs raises ONE degradation
 *                         signal (per-peer FailureEpisodeLatch — P19 cond. 4).
 *   isSuspect(peer)     — true inside the window. The composed isMachineAlive
 *                         then short-circuits dispatches for ALL of that
 *                         peer's sessions straight to the existing failover
 *                         re-place path — no per-message retry tax repaid.
 *   recordSuccess(peer) — a delivery reached the peer: window cleared,
 *                         recovery logged once, latch re-armed.
 *
 *   After the TTL expires the breaker is HALF-OPEN: the next message tries the
 *   peer for real (paying one retry cycle); success clears, failure re-marks.
 *   The peer is never written off permanently — the TTL is the backoff, the
 *   suspect state is the breaker, the per-message retry config is the cap.
 *
 * Deliberately POLICY-NEUTRAL: what happens to messages while a peer is
 * suspect (today: the router's existing re-place path) is the wiring's choice
 * — the queue-vs-replace stability policy is a separate operator decision
 * <!-- tracked: CMT-1109 -->. Pure: injectable clock, per-peer bounded state.
 */

import { FailureEpisodeLatch } from './FailureEpisodeLatch.js';

export interface OwnerSuspectBreakerOpts {
  /** Suspect window per mark (the half-open backoff). Default 30s. */
  suspectTtlMs?: number;
  /** Sustained-suspicion threshold for the one-per-episode degradation signal. Default 10min. */
  signalAfterMs?: number;
  now?: () => number;
  logger?: (msg: string) => void;
  /** One-per-episode sustained-suspicion sink (wired to DegradationReporter). */
  reportSustained?: (info: { machineId: string; suspectForMs: number; marks: number }) => void;
}

const DEFAULT_SUSPECT_TTL_MS = 30_000;
const DEFAULT_SIGNAL_AFTER_MS = 10 * 60_000;

export class OwnerSuspectBreaker {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly opts: OwnerSuspectBreakerOpts;
  /** Per-peer suspect-window end (ms epoch). Deleted on success. */
  private suspectUntil = new Map<string, number>();
  /** Per-peer episode accounting (created on first mark, deleted on success). */
  private episodes = new Map<string, FailureEpisodeLatch>();

  constructor(opts: OwnerSuspectBreakerOpts = {}) {
    this.opts = opts;
    this.ttlMs = opts.suspectTtlMs ?? DEFAULT_SUSPECT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  private log(m: string): void {
    this.opts.logger?.(`[owner-suspect] ${m}`);
  }

  /** Delivery retries to this peer exhausted — open its suspect window.
   *
   * ABSOLUTE per-episode TTL: a mark that arrives while a window is ALREADY open
   * does NOT push the window end forward. Otherwise a steady message stream
   * arriving faster than the TTL would re-extend the window on every dispatch
   * (each suspect dispatch re-enters dispatchOne's dead-owner branch, which
   * re-calls markOwnerSuspect), so `isSuspect` would never go false at the
   * moment a message arrives — the half-open re-probe (the ONLY path that ever
   * re-attempts delivery and thus the ONLY path that can clear suspicion) would
   * never be reached, leaving a fully-RECOVERED peer suspect forever and
   * force-failing-over all its sessions on every message. The episode latch
   * still records each mark (sustained-suspicion accounting), but the window
   * end is fixed at the first mark of each TTL period. */
  markSuspect(machineId: string): void {
    if (!this.isSuspect(machineId)) {
      this.suspectUntil.set(machineId, this.now() + this.ttlMs);
    }
    let latch = this.episodes.get(machineId);
    if (!latch) {
      latch = new FailureEpisodeLatch({
        signalAfterMs: this.opts.signalAfterMs ?? DEFAULT_SIGNAL_AFTER_MS,
        now: this.now,
      });
      this.episodes.set(machineId, latch);
    }
    const f = latch.recordFailure();
    if (f.firstOfEpisode) {
      this.log(`owner ${machineId} SUSPECT (delivery retries exhausted) — short-circuiting its sessions' dispatches for ${Math.round(this.ttlMs / 1000)}s windows until a delivery succeeds`);
    }
    if (f.shouldSignal) {
      this.log(`owner ${machineId} suspect for ${Math.round(f.failingForMs / 60_000)}min (${f.failures} marks) — signaling once; half-open re-probes continue`);
      this.opts.reportSustained?.({ machineId, suspectForMs: f.failingForMs, marks: f.failures });
    }
  }

  /** Inside an open suspect window? (Half-open after the TTL — callers re-probe.) */
  isSuspect(machineId: string): boolean {
    const until = this.suspectUntil.get(machineId);
    return until !== undefined && this.now() < until;
  }

  /** A delivery reached the peer — close the episode and re-arm. */
  recordSuccess(machineId: string): void {
    this.suspectUntil.delete(machineId);
    const latch = this.episodes.get(machineId);
    if (latch) {
      const s = latch.recordSuccess();
      if (s.recovered) this.log(`owner ${machineId} recovered after ${s.failures} suspect mark(s)`);
      this.episodes.delete(machineId);
    }
  }
}
