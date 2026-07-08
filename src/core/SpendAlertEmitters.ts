/**
 * SpendAlertEmitters — the Increment-C trigger set of the Routing Control Room
 * (docs/specs/routing-control-room-spend-alerts.md, §Surface 2 Alerts —
 * Triggers, "Self-Heal Before Notify").
 *
 * Every emitter is a SIGNAL consumer feeding the SpendAlertDispatcher: it
 * blocks nothing, gates nothing, and throw-swallows so a notifier failure can
 * never disturb the gate/router path it observes.
 *
 * Kinds produced here:
 *  - cap-approach — 50%/80% on BOTH daily AND lifetime (G4), edge-triggered per
 *    (capKind, threshold, window); coalesced into the digest.
 *  - cap-hit — ONE edge-triggered money-critical alert, worded honestly
 *    ("a reservation would exceed key X's daily cap", actual vs reserved —
 *    A-Min13). Protective; the adjust action is the operator's.
 *  - door-dark — downstream of swap-tail self-heal; escalates only on
 *    whole-chain exhaustion (RouterFailClosedError plans). P19 brakes:
 *    max-attempts = chain length per episode bucket, widening backoff, a
 *    flapping breaker (N exhaustions/window → critical wording, bypasses
 *    coalescing via the money-critical lane), scrubbed jsonl (the dispatcher's).
 *  - fallback-spike — routine self-healed fallback churn is NOT an operator
 *    event (Near-Silent): every fallback is counted; a digest line fires ONLY
 *    when the hourly rate crosses an absolute ceiling (code constant).
 *  - holder-dead — the ONE named exception to holder-single-voice (A2-2): a
 *    SURVIVING machine emits when the pool observes the metered-lease holder
 *    offline past the mesh-death threshold while any door is live. Stable
 *    pool-wide dedupe key `spend-holder-dead:<keyEpoch>`. Single-machine:
 *    strict no-op (there is no surviving other voice).
 *  - recon-drift — the emit surface for the Layer-1c provider-reconciliation
 *    sweep (lands next PR); wording per Amendment 1.
 */

import type { SpendAlertDispatcher } from './SpendAlertDispatcher.js';

/** Cap-approach thresholds (G4) — code-defined, both cap kinds. */
export const CAP_APPROACH_THRESHOLDS = [0.5, 0.8] as const;

/** Fallback-spike absolute per-hour ceiling (code constant — Near-Silent default). */
export const FALLBACK_SPIKE_PER_HOUR_CEILING = 60;

/** Door-dark flapping breaker: N exhaustions inside the window escalate the wording. */
export const DOOR_DARK_FLAP_THRESHOLD = 5;
export const DOOR_DARK_FLAP_WINDOW_MS = 60 * 60 * 1000;
/** Door-dark per-episode widening backoff base + episode bucket size. */
export const DOOR_DARK_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const DOOR_DARK_EPISODE_BUCKET_MS = 6 * 60 * 60 * 1000;

export interface GateAdmitEvent {
  type: 'admit';
  keyRef: string;
  door: string;
  committedLifetimeUsd: number;
  committedDayUsd: number;
  lifetimeCapUsd: number;
  dailyCapUsd: number;
}

export interface GateRefusalEvent {
  type: 'refusal';
  reason: string; // MoneyGateRefusalReason — 'cap-exceeded' is the alerting one
  keyRef?: string;
  door?: string;
  detail: string;
}

export type GateEvent = GateAdmitEvent | GateRefusalEvent;

export interface NatureRoutePlanEvent {
  component?: string;
  dryRun: boolean;
  failClosed?: boolean;
  resolution?: { outcome?: string; resolvedChain?: string; swapTail?: unknown[]; primary?: { door?: string } };
  /** True when the served position was NOT the chain primary (a fallback served). */
  servedFallback?: boolean;
}

export interface SpendAlertEmittersOptions {
  dispatcher: SpendAlertDispatcher;
  machineId: string;
  now?: () => number;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class SpendAlertEmitters {
  private readonly dispatcher: SpendAlertDispatcher;
  private readonly machineId: string;
  private readonly now: () => number;

  /** door-dark per-episode state: chain → { bucket, attempts, nextAllowedAtMs, exhaustionsWindow } */
  private doorDark = new Map<string, { bucket: number; attempts: number; nextAllowedAtMs: number; exhaustions: number[] }>();
  /** fallback counter: hour-bucket → count (bounded: only the current bucket is kept). */
  private fallbackBucket = { hour: -1, count: 0 };

  constructor(opts: SpendAlertEmittersOptions) {
    this.dispatcher = opts.dispatcher;
    this.machineId = opts.machineId;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Observer-isolated dispatch: the real dispatcher never throws/rejects, but
   * the observer CONTRACT must hold against any implementation — a sync throw
   * OR an async rejection here can never reach the gate/router path, and can
   * never surface as an unhandled rejection.
   */
  private fire(alert: Parameters<SpendAlertDispatcher['dispatch']>[0]): void {
    try {
      void Promise.resolve(this.dispatcher.dispatch(alert)).catch(() => {});
    } catch {
      // @silent-fallback-ok: observer isolation — a throwing dispatcher is the
      // notifier's failure, never the observed path's.
    }
  }

  /** The MeteredSpendGate observer (onGateEvent). NEVER throws into the gate path. */
  onGateEvent(ev: GateEvent): void {
    try {
      if (ev.type === 'admit') {
        this.checkCapApproach(ev);
      } else if (ev.reason === 'cap-exceeded') {
        this.fire({
          kind: 'cap-hit',
          dedupeKey: `spend-cap-hit:${ev.keyRef ?? 'unknown'}:${utcDay(this.now())}`,
          text:
            `🛑 Spending cap hit: a reservation would exceed key '${ev.keyRef ?? 'unknown'}'s cap — ${ev.detail}. ` +
            `The call fell to a free door (paid routing on this key is refusing new spend). ` +
            `Raising the cap is your PIN action on the Spend tab; the freeze/disarm levers are one tap.`,
        });
      }
    } catch {
      // @silent-fallback-ok: a notifier failure must never disturb the gate path.
    }
  }

  private checkCapApproach(ev: GateAdmitEvent): void {
    const checks: Array<{ capKind: 'daily' | 'lifetime'; committed: number; cap: number; window: string }> = [
      { capKind: 'daily', committed: ev.committedDayUsd, cap: ev.dailyCapUsd, window: utcDay(this.now()) },
      { capKind: 'lifetime', committed: ev.committedLifetimeUsd, cap: ev.lifetimeCapUsd, window: 'lifetime' },
    ];
    for (const c of checks) {
      if (!(c.cap > 0)) continue;
      const frac = c.committed / c.cap;
      for (const threshold of CAP_APPROACH_THRESHOLDS) {
        if (frac >= threshold) {
          // Edge per (capKind, threshold, window) — the dispatcher's latch dedupes.
          this.fire({
            kind: 'cap-approach',
            dedupeKey: `spend-approach:${ev.keyRef}:${c.capKind}:${threshold}:${c.window}`,
            text:
              `📊 Key '${ev.keyRef}' is at ${Math.round(frac * 100)}% of its ${c.capKind} cap ` +
              `($${c.committed.toFixed(2)} of $${c.cap.toFixed(2)} committed).`,
          });
        }
      }
    }
  }

  /**
   * The router-signal consumer (fed by the onNatureRoutePlan fan-out, I-9).
   * Counts every served fallback (Near-Silent: jsonl only via the dispatcher's
   * audit); emits a digest line ONLY on a rate spike; escalates door-dark on
   * whole-chain exhaustion with P19 brakes.
   */
  onNatureRoutePlan(plan: NatureRoutePlanEvent): void {
    try {
      if (plan.failClosed) {
        this.onChainExhausted(plan.resolution?.resolvedChain ?? 'unknown', Array.isArray(plan.resolution?.swapTail) ? plan.resolution.swapTail.length + 1 : 3);
        return;
      }
      if (plan.servedFallback) this.onFallbackServed();
    } catch {
      // @silent-fallback-ok: observer isolation (I-9) — a notifier failure never
      // breaks the LLM call path or the sibling fan-out subscribers.
    }
  }

  private onChainExhausted(chain: string, chainLength: number): void {
    const nowMs = this.now();
    const bucket = Math.floor(nowMs / DOOR_DARK_EPISODE_BUCKET_MS);
    let st = this.doorDark.get(chain);
    if (!st || st.bucket !== bucket) {
      st = { bucket, attempts: 0, nextAllowedAtMs: 0, exhaustions: st?.exhaustions ?? [] };
      this.doorDark.set(chain, st);
    }
    // Flapping breaker window bookkeeping (kept small: prune outside the window).
    st.exhaustions.push(nowMs);
    st.exhaustions = st.exhaustions.filter((t) => nowMs - t <= DOOR_DARK_FLAP_WINDOW_MS);
    const flapping = st.exhaustions.length >= DOOR_DARK_FLAP_THRESHOLD;

    // P19 brakes: max-attempts = chain length per episode bucket + widening backoff.
    if (st.attempts >= chainLength) return; // episode budget spent — the bucket rolling re-arms
    if (nowMs < st.nextAllowedAtMs) return; // inside the widening backoff window
    st.attempts += 1;
    st.nextAllowedAtMs = nowMs + DOOR_DARK_BACKOFF_BASE_MS * Math.pow(2, st.attempts - 1);

    this.fire({
      kind: 'door-dark',
      dedupeKey: `spend-door-dark:${this.machineId}:${chain}:${bucket}:${st.attempts}`,
      text: flapping
        ? `🚨 Routing chain '${chain}' is FLAPPING dark (${st.exhaustions.length} full exhaustions in the last hour) — ` +
          `every door including the free tails failed repeatedly. Gated work on this chain is failing closed.`
        : `⚠️ Routing chain '${chain}' went dark — every door including the free tails was unavailable ` +
          `(attempt ${st.attempts}/${chainLength} this episode). Self-heal continues; this is the whole-chain escalation.`,
      // The flapping escalation must not sit in a digest: shorten its re-arm instead
      // of switching lanes (kinds keep their lane — S-F8).
      ...(flapping ? { reArmMs: 30 * 60 * 1000 } : {}),
    });
  }

  private onFallbackServed(): void {
    const hour = Math.floor(this.now() / 3_600_000);
    if (this.fallbackBucket.hour !== hour) this.fallbackBucket = { hour, count: 0 };
    this.fallbackBucket.count += 1;
    if (this.fallbackBucket.count === FALLBACK_SPIKE_PER_HOUR_CEILING) {
      // Edge exactly at the ceiling crossing — once per hour bucket by construction.
      this.fire({
        kind: 'fallback-spike',
        dedupeKey: `spend-fallback-spike:${this.machineId}:${hour}`,
        text:
          `📈 Routing fallback rate spiked: ${this.fallbackBucket.count} fallback-served calls this hour ` +
          `(ceiling ${FALLBACK_SPIKE_PER_HOUR_CEILING}). Primaries are degrading — the chains are self-healing, ` +
          `but persistent churn is worth a look at the Routing Map.`,
      });
    }
  }

  /**
   * holder-dead (A2-2): call from pool observation when the metered-lease
   * holder is offline past the mesh-death threshold while any door is live.
   * The caller (a SURVIVING machine) supplies the keyEpoch for the stable
   * pool-wide dedupe key. Single-machine installs never call this.
   */
  onMeteredLeaseHolderDead(holderNickname: string, keyEpoch: number): void {
    try {
      this.fire({
        kind: 'holder-dead',
        dedupeKey: `spend-holder-dead:${keyEpoch}`,
        text:
          `🚨 Paid routing is frozen — the metered-lease machine '${holderNickname}' is offline past the ` +
          `mesh-death threshold while paid doors are live. Free doors still serve. Reclaim/re-designate from ` +
          `the dashboard Spend tab (PIN) when you've confirmed the machine is really gone.`,
      });
    } catch {
      // @silent-fallback-ok: the surviving-voice alert is best-effort — pool
      // observation re-fires it on its next tick if this dispatch failed.
    }
  }

  /** recon-drift emit surface (Layer 1c feeds this next PR — Amendment 1 wording). */
  onReconciliationDrift(keyRef: string, door: string, driftPct: number): void {
    try {
      const bucket = driftPct >= 0 ? Math.floor(driftPct / 10) : Math.ceil(driftPct / 10);
      this.fire({
        kind: 'recon-drift',
        dedupeKey: `spend-recon-drift:${keyRef}:${door}:${bucket}`,
        text:
          `🧾 ${door} reports ~${Math.abs(Math.round(driftPct))}% ${driftPct > 0 ? 'more' : 'less'} than we booked ` +
          `for key '${keyRef}' — your reviewed price may be stale; consider promoting the observed price (PIN).`,
      });
    } catch {
      // @silent-fallback-ok: reporting-side observability; the sweep re-fires next pass.
    }
  }
}
