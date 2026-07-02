/**
 * LeaseAcquisitionTrigger — U4.1 §2D's "becoming placement router triggers one
 * immediate reconciler tick" (docs/specs/u4-1-pin-persistence.md).
 *
 * A tiny, pure transition detector polled on a short cadence: when
 * `holdsLease()` goes false→true (lease acquisition — and BOOT-as-holder,
 * since the initial state is deliberately false), it fires `onAcquired()`
 * exactly once for that acquisition. Replay is a reconciler INPUT, never a
 * second transfer-initiating pass — the fired tick is the SAME
 * `OwnershipReconciler.tick()` the cadence runs.
 *
 * Epoch fencing: the trigger fires only while the lease is STILL HELD at
 * fire time (the poll reads `holdsLease()` and fires in the same breath); a
 * stale router — one that lost the lease between polls — observes false and
 * fires nothing. Every action inside the tick is additionally CAS-fenced by
 * the ownership registry, so even a raced fire initiates nothing a
 * non-holder could not legitimately do on its own cadence.
 *
 * Fail-open toward silence: an unreadable lease skips the acquisition tick
 * (the 30s cadence tick still converges); a throwing `onAcquired` never
 * poisons the transition state (the next acquisition still fires).
 */

export interface LeaseAcquisitionTriggerDeps {
  holdsLease: () => boolean;
  onAcquired: () => void;
}

export class LeaseAcquisitionTrigger {
  private readonly d: LeaseAcquisitionTriggerDeps;
  /** Starts FALSE so the first held observation (boot as the holder) fires. */
  private wasHolder = false;

  constructor(deps: LeaseAcquisitionTriggerDeps) {
    this.d = deps;
  }

  /** One poll step. Returns true when the acquisition fire happened. */
  poll(): boolean {
    let holder: boolean;
    try {
      holder = !!this.d.holdsLease();
    } catch {
      // @silent-fallback-ok — an unreadable lease fails toward SILENCE by design
      // (U4.1 §2D): the acquisition tick is an optimization; the 30s cadence tick
      // still converges, so skipping is the safe direction, never a lost pin.
      return false;
    }
    const fired = holder && !this.wasHolder;
    this.wasHolder = holder;
    if (fired) {
      try { this.d.onAcquired(); } catch { /* a throwing tick never poisons the transition state */ }
    }
    return fired;
  }
}
