/**
 * Why POST /pool/transfer reports `seatMoved:false`. A timeout means the caller stopped
 * waiting, not that the drain failed: on 2026-11-04 one answered this way and the move landed
 * 24 s later. `seatMoved` stays false either way, because `ok` must never read as `moved`,
 * but the reason must not claim what is not known.
 */
export function seatNotMovedReason(drain: { attempted: boolean; ok?: boolean; reason?: string }): string {
  if (drain.attempted && drain.ok === false && drain.reason === 'status-408') {
    return 'the owner did not answer in time, so the move may still land: read GET /pool/placement';
  }
  if (drain.attempted && drain.ok === false) {
    return 'drain failed — the seat did not move (topic stays whole on its current machine)';
  }
  return 'ownership did not transfer to the target (the pin is set, but the target is not the active owner)';
}
