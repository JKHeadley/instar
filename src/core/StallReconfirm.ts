/**
 * StallReconfirm — a machine that has just come back from a long main-thread stall (or a
 * sleep) does not take the lead on a lease that only looks expired because it was not
 * running (docs/specs/stall-wake-lease-reconfirm.md, fb-fdb55c1c-a79). Pure: no I/O, no
 * clock, so every boundary is unit-testable.
 *
 * The defect: while this process is stalled it folds nothing, so its copy of a live peer's
 * lease ages past the TTL. A mechanism consistent with the logs (no callback trace exists): at
 * wake, libuv runs the overdue timers before it reads the buffered inbound renewals and pull
 * replies, so the lease tick can claim from that aged copy within a second of waking
 * (2026-11-21 16:09:48Z and 08:30:23 PST, Laptop over a healthy Studio).
 *
 * The rule: once this machine has lost more than 30% of a TTL of running time within one TTL
 * (one long gap in its own awake clock, or a burst of shorter ones), a claim on a lapsed-looking
 * lease waits until a full lease TTL has passed AWAKE since the gap and a pull round that started
 * after it has completed (its replies folded). The lease's expiry is then measured entirely on an
 * awake clock, which is exactly what today's rule assumes, so a dead holder is taken over one TTL
 * after the stall, and a live holder's renewal (pushed, or returned by that round) has been folded
 * and refuses the claim first. A machine that keeps stalling is bounded by the chain cap.
 * (Two shortcuts were rejected in review: "the holder said it holds nothing", and "the holder was
 * silent on post-stall probes". A probe records only when a dial ENDED, so a reply or timeout from
 * a dial sent before the stall and read at wake can pass for fresh evidence; only a round that
 * this machine STARTED after the stall and saw complete is evidence about after the stall.)
 * A live holder needs none of this: its renewal arrives by push or by the fresh pull, is
 * folded, and the normal acquisition check refuses the claim before this rule is reached.
 *
 * Signal-only in spirit: it can only withhold a claim the normal rules would already make,
 * never make one they would refuse.
 */

export interface StallReconfirmSettings {
  enabled: boolean;
  /** Running time lost within one TTL that opens an episode. Absent ⇒ 30% of the lease TTL (18 s at 60 s), floor 5 s; an override is clamped to [1 s, TTL/2]. */
  stallGapMs?: number;
}

/** The share of the TTL the lost running time must exceed to open an episode (see stallGapMsFor). */
export const STALL_GAP_TTL_FRACTION = 0.3;
const STALL_GAP_FLOOR_MS = 5_000;
/** How often the lease coordinator stamps its awake clock while the switch is on. */
export const AWAKE_STAMP_INTERVAL_MS = 2_000;

/**
 * The lost running time (within one TTL) that opens an episode. A renewing holder's lease, as
 * this machine last folded it, has at least TTL/2 left at the fold (renewals every TTL/2), and
 * the copy keeps ageing between pulls (5 s) and by the delivery time; so a live holder's copy
 * can look expired after a loss of TTL/2 − 5 s − delivery (about 25 s at a 60 s TTL, less on a
 * slow route). 30% of the TTL (18 s) sits below that with a margin. An override is clamped to
 * [1 s, TTL/2]: above TTL/2 the rule could never fire before a live copy expires.
 */
export function stallGapMsFor(ttlMs: number, configured?: number): number {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(1_000, Math.floor(configured)), Math.max(1_000, Math.floor(ttlMs / 2)));
  }
  return Math.min(Math.max(STALL_GAP_FLOOR_MS, Math.round(ttlMs * STALL_GAP_TTL_FRACTION)), Math.max(1_000, Math.floor(ttlMs / 2)));
}

/**
 * Resolve the switch from the agent config, read live. Dark everywhere: only an explicit
 * `multiMachine.takeoverReadyPool.stallReconfirm.enabled: true` turns it on, and
 * `takeoverReadyPool.enabled: false` (the project's rollback) turns it off.
 */
export function resolveStallReconfirm(config: {
  multiMachine?: { takeoverReadyPool?: { enabled?: boolean; stallReconfirm?: { enabled?: boolean; stallGapMs?: number } } };
} | undefined): StallReconfirmSettings {
  const pool = config?.multiMachine?.takeoverReadyPool;
  const part = pool?.stallReconfirm;
  const enabled = pool?.enabled === false ? false : part?.enabled === true;
  return {
    enabled,
    // Passed through as set; stallGapMsFor clamps it to [1 s, TTL/2] against the live TTL.
    ...(typeof part?.stallGapMs === 'number' && Number.isFinite(part.stallGapMs) && part.stallGapMs > 0 ? { stallGapMs: part.stallGapMs } : {}),
  };
}

/** The awake-clock gap between two stamps: the larger of the wall and monotonic deltas. */
export function awakeGapMs(prev: { wallMs: number; monoMs: number }, next: { wallMs: number; monoMs: number }): number {
  // The wall clock moves through a sleep that the macOS monotonic clock skips; the monotonic
  // clock is immune to a wall step backward. A step forward reads as a gap, the safe side.
  return Math.max(next.wallMs - prev.wallMs, next.monoMs - prev.monoMs, 0);
}

/** A gap below this (three stamp intervals) is ordinary scheduling; at or above it, the whole gap counts. */
export const LOST_GAP_FLOOR_MS = 6_000;

/**
 * Running time lost in one gap between awake stamps (0 for an ordinary gap). The whole gap
 * counts, not the gap less one interval: the folded lease ages by the whole gap.
 */
export function lostInGapMs(gapMs: number): number {
  return gapMs >= LOST_GAP_FLOOR_MS ? gapMs : 0;
}

/**
 * Running time lost over the last `windowMs` (one lease TTL): the sum of the losses still inside
 * it. A burst of 11-21 s stalls (the Laptop at 00:27 PST, 2026-11-21) adds up the same way one
 * 226 s stall does, because either can leave a live holder's lease looking expired.
 */
export function lostWithinMs(samples: ReadonlyArray<{ atMs: number; lostMs: number }>, nowMs: number, windowMs: number): number {
  let sum = 0;
  for (const s of samples) if (nowMs - s.atMs <= windowMs) sum += s.lostMs;
  return sum;
}

/**
 * The availability bound: a chain of re-opened episodes (a machine that keeps stalling) holds a
 * claim at most this long, after which a completed fresh round is enough. Ten lease lifetimes at
 * Echo's TTL; a pool with no other candidate is then without a lead for at most ten minutes.
 */
export const STALL_CHAIN_CAP_TTLS = 10;

export interface StallReconfirmInput {
  nowMs: number;
  /** When the episode opened (the first stamp after the gap). */
  episodeOpenedAtMs: number;
  ttlMs: number;
  /** The machine the view names as holder ('' or this machine's own id when none other). */
  holderId: string;
  /**
   * A pull round that started after the episode opened AND after the latest gap that lost time
   * has completed (its replies folded).
   */
  freshRoundCompleted: boolean;
  /** Running time lost since the episode opened, in gaps too small to re-open it; C counts awake time only. */
  lostSinceOpenMs?: number;
  /** Awake (monotonic) time since the first episode of this chain of re-opens opened; defaults to wall time since the episode opened. */
  chainAwakeMs?: number;
}

export type StallReconfirmRule = 'awake-ttl' | 'chain-cap' | 'waiting';

export interface StallReconfirmVerdict {
  /** True: the claim may go ahead on the normal rules. False: hold it. */
  claim: boolean;
  rule: StallReconfirmRule;
  reason: string;
}

export function evaluateStallReconfirm(input: StallReconfirmInput): StallReconfirmVerdict {
  const holder = input.holderId || '(none)';
  const sinceOpen = Math.max(0, input.nowMs - input.episodeOpenedAtMs - (input.lostSinceOpenMs ?? 0));
  // C — a full TTL awake since the gap, with a completed fresh round: today's rule, on an awake clock.
  if (sinceOpen >= input.ttlMs && input.freshRoundCompleted) {
    return { claim: true, rule: 'awake-ttl', reason: `no renewal from ${holder} reached this machine in ${Math.round(input.ttlMs / 1000)} s awake after the stall` };
  }
  // The availability bound for a machine that keeps stalling, on the monotonic clock (a wall-clock
  // step cannot age it). It still needs a round started after the latest loss and completed, so a
  // claim at the cap never precedes the renewals buffered during that loss.
  const chainMs = input.chainAwakeMs ?? Math.max(0, input.nowMs - input.episodeOpenedAtMs);
  if (chainMs >= STALL_CHAIN_CAP_TTLS * input.ttlMs && input.freshRoundCompleted) {
    return { claim: true, rule: 'chain-cap', reason: `this machine has kept stalling for ${Math.round(chainMs / 1000)} s; a completed fresh round found no live holder` };
  }
  return { claim: false, rule: 'waiting', reason: `holder ${holder} not yet re-confirmed after the stall (${Math.round(sinceOpen / 1000)} s awake of ${Math.round(input.ttlMs / 1000)} s${input.freshRoundCompleted ? '' : ', no fresh pull round completed yet'})` };
}
