/**
 * SustainedOnlineTracker — U4.1 §2E hysteresis input ("pin persistence",
 * docs/specs/u4-1-pin-persistence.md).
 *
 * Answers ONE question for pin-driven actuation: "has this machine been
 * CONTINUOUSLY online for at least the sustained window?" — the anti-flap
 * gate that keeps a returning-but-flapping pinned machine from triggering
 * transfer ping-pong (mirror of U4.4's hysteresis), and keeps Case-A
 * cooperative transfers from initiating toward a machine that only just
 * blinked online (R-r2-2: the transfer→abort churn loop).
 *
 * Feeding: `observe(machines)` is called on the reconciler tick cadence with
 * the live pool view. A machine seen online starts (or continues) its
 * online-since clock; seen offline/absent resets it.
 *
 * Boot honesty (deliberate fail-open): the tracker cannot distinguish
 * "stable for hours" from "just flapped on" until it has watched for at
 * least one full window. While its own observation history is younger than
 * the queried window, `sustainedOnline` falls back to the CURRENT online
 * bit (today's behavior) — otherwise every pinned placement would queue for
 * the window length after every boot, a routine-latency regression the
 * anti-flap gate was never meant to buy. After the tracker has ≥ window of
 * history the gate is fully meaningful.
 */

export interface SustainedOnlineView {
  machineId: string;
  online: boolean;
}

export class SustainedOnlineTracker {
  /** machineId → epoch-ms the machine was first seen online in its CURRENT unbroken online run. */
  private readonly onlineSince = new Map<string, number>();
  private readonly now: () => number;
  /** When this tracker started observing (the boot fail-open boundary). */
  private readonly trackingSince: number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
    this.trackingSince = this.now();
  }

  /** Fold one live pool view into the online-run clocks. */
  observe(machines: ReadonlyArray<SustainedOnlineView>): void {
    const t = this.now();
    const seenOnline = new Set<string>();
    for (const m of machines) {
      if (!m.online) continue;
      seenOnline.add(m.machineId);
      if (!this.onlineSince.has(m.machineId)) this.onlineSince.set(m.machineId, t);
    }
    // A machine reported offline — or absent from the view — breaks its run.
    for (const id of [...this.onlineSince.keys()]) {
      if (!seenOnline.has(id)) this.onlineSince.delete(id);
    }
  }

  /**
   * Has `machineId` been continuously online for ≥ `windowMs`?
   * Boot fail-open: while the tracker's own history is younger than the
   * window, this degrades to "is it online right now" (see header).
   */
  sustainedOnline(machineId: string, windowMs: number): boolean {
    const since = this.onlineSince.get(machineId);
    if (since === undefined) return false; // not online right now — never sustained
    const t = this.now();
    if (t - this.trackingSince < windowMs) return true; // fail-open boot window (online now)
    return t - since >= windowMs;
  }
}
