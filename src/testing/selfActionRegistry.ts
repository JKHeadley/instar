/**
 * selfActionRegistry.ts — the self-action controller registry (Part D1 of
 * docs/specs/self-action-convergence.md). This is the single list the
 * convergence ratchet (`tests/unit/self-action-convergence.test.ts`) iterates,
 * the direct analog of `lint-no-unbounded-llm-spawn.js`'s one closed set of
 * provider classes: one place to look, one thing the ratchet drives.
 *
 * WHY a modeled registry (not the live controllers): the real controllers
 * (SubscriptionPool proactive swap, SessionReaper age-kill, PromiseBeacon) are
 * bound to tmux, HTTP, config, and a real wall clock — undrivable
 * deterministically. Each entry here is a FAITHFUL, minimal convergence MODEL of
 * a real controller's trigger -> brake -> emit shape under the pinned
 * sustained-pressure fixture (Part D2), with a pointer to the real source. The
 * ratchet proves the BRAKE converges; the forcing lint
 * (`scripts/lint-no-unregistered-self-action.js`) proves COMPLETENESS (a new
 * self-action emit must register here). The two together make the closure
 * genuine rather than opt-in.
 *
 * Constitution: "Capacity Safety — No Unbounded Self-Action" (the temporal twin
 * of "Bounded Blast Radius": BBR bounds instantaneous MASS, this bounds
 * steady-state FREQUENCY under feedback).
 */

import { EMPTY_KILL_LEDGER, isBreakerTripped, recordKill } from '../monitoring/ExternalHogKillLedger.js';

/** A deterministic virtual clock — no real time, no randomness (a fixed adversary). */
export interface VirtualClock {
  nowMs(): number;
  advance(ms: number): void;
}

/**
 * The sustained worst case that never clears on its own — the exact condition
 * swap-thrash ran under. Deterministic by construction (no fuzzing): a ping-pong
 * cannot hide behind randomness.
 */
export interface PressureFixture {
  clock: VirtualClock;
  /** All quota readings >= threshold, forever (the all-hot condition). */
  everyAccountHot(): boolean;
  /** All sessions mid-turn / carrying subagents (no idle window ever opens). */
  everySessionBusy(): boolean;
  /** The peer/CI/flush the loop retries against always rejects (veto never clears). */
  targetAlwaysRejects(): boolean;
  /** A polled quota value that LAGS real state — so a just-vacated account still reads sub-threshold. */
  staleQuotaReading(accountId: string): number;
}

/**
 * Where a controller's actions land. `considered` proves the fixture actually
 * pressured the controller (a controller cannot pass by being inertly idle);
 * `count` is the invariant subject; `perTarget` feeds the anti-ping-pong check.
 */
export interface ActionSink {
  emit(action: { verb: string; target: string }): void;
  count: number;
  perTarget: Map<string, number>;
  considered: number;
  /** Virtual-clock timestamps of each emit, for the eternal-sentinel rate-floor assertion. */
  emitTimesMs: number[];
}

/** Create a fresh sink. */
export function makeActionSink(): ActionSink {
  const sink: ActionSink = {
    count: 0,
    considered: 0,
    perTarget: new Map<string, number>(),
    emitTimesMs: [],
    emit(action: { verb: string; target: string }) {
      sink.count += 1;
      sink.perTarget.set(action.target, (sink.perTarget.get(action.target) ?? 0) + 1);
    },
  };
  return sink;
}

export interface SelfActionController {
  /** Stable id (greppable by the forcing lint). */
  id: string;
  /** The action verb — MUST contain a detector token (SELF_ACTION_VERB_TOKENS). */
  actionVerb: string;
  /** Real source this models (documentation + audit trail). */
  models: string;
  /** Build the controller under a fixture + sink; returns something with tick(). */
  makeUnderPressure(f: PressureFixture, sink: ActionSink): { tick(): void };
  /** Proven max total actions over `ticks` under the pinned pressure. */
  boundK: number;
  /** Proven max actions against ANY single target (anti-ping-pong). */
  perTargetBoundK: number;
  /** N — the sustained-pressure horizon (ticks driven). */
  ticks: number;
  /** Virtual ms the clock advances each tick. */
  tickMs: number;
  /** A declared Eternal Sentinel (P19 exemption) — replaces the count bound with a rate-floor bound. */
  eternalSentinel?: { reason: string; rateFloorMs: number };
}

// ── The seeded controllers ─────────────────────────────────────────────────

/**
 * proactive-swap-monitor — THE presenting case (#1035, ff3083a31). The real
 * proactive pre-limit account swap self-triggered ~72 swaps/day via a
 * quota-POSITIVE kill+respawn. Models the shipped "three brakes" fix
 * (SubscriptionPool proactiveSwap antiThrash): under the pinned all-hot
 * fixture, the ALL-HOT brake refuses every candidate swap (STAY PUT) and the
 * projected-post-swap-load gate refuses a target that a stale reading makes look
 * cool-but-actually-hot — so the count settles to 0, horizon-independent, not
 * 72/day.
 */
const proactiveSwapMonitor: SelfActionController = {
  id: 'proactive-swap-monitor',
  actionVerb: 'account-swap',
  models: 'src/monitoring/SubscriptionPool.ts (proactive pre-limit swap, antiThrash all-hot + projected-load brake)',
  boundK: 1,
  perTargetBoundK: 1,
  ticks: 20,
  tickMs: 5 * 60_000, // 5 min/tick — crosses the ~45-min dwell window several times
  makeUnderPressure(f, sink) {
    const CANDIDATES = ['acct-A', 'acct-B'];
    const REHYDRATION_BURST_PCT = 15; // a swap's own kill+re-hydrate lands on the destination
    return {
      tick() {
        sink.considered += 1;
        // Brake 1 — ALL-HOT: when every account reads hot, staying put beats a
        // pointless kill+re-hydrate. Under the pinned fixture this is true
        // forever, so the loop converges to 0 (the swap-thrash fix).
        if (f.everyAccountHot()) return;
        // Brake 2 — PROJECTED-POST-SWAP-LOAD: gate on (target current + this
        // swap's re-hydration burst), NOT the stale current reading. A target
        // that a lagging poll makes look cool but that this swap would itself
        // push hot is refused — the amplifying edge that caused the ping-pong.
        const target = CANDIDATES.find((id) => {
          const projected = f.staleQuotaReading(id) + REHYDRATION_BURST_PCT;
          return projected < 80;
        });
        if (!target) return; // no MATERIALLY-cooler destination -> stay put
        sink.emit({ verb: 'account-swap', target });
      },
    };
  },
};

/**
 * age-kill-backoff — the 2026-06-05 reaper age-gate that fired 17,503 identical
 * kill requests/day (request -> veto -> re-request every 5s). Models the P19
 * fix: exponential backoff between attempts + a breaker cap that gives up
 * LOUDLY. Under the pinned targetAlwaysRejects fixture (the veto never clears —
 * a protected/in-flight session), the count settles to `maxAttempts` and the
 * breaker opens, horizon-independent.
 */
const ageKillBackoff: SelfActionController = {
  id: 'age-kill-backoff',
  actionVerb: 'age-kill',
  models: 'src/monitoring/SessionReaper.ts (age-limit kill-request; AgeKillBackoff — P19 backoff + breaker)',
  boundK: 5,
  perTargetBoundK: 5, // legitimately the SAME session, bounded by the breaker (not a ping-pong)
  // Horizon chosen so N ticks FULLY reaches the breaker cap (cumulative
  // exponential backoff to the 5th attempt is ~150s = 30 ticks); N=50 and
  // 2N=100 both settle at 5, so the horizon-independence check is exact.
  ticks: 50,
  tickMs: 5_000, // 5s/tick — the original re-request cadence
  eternalSentinel: undefined,
  makeUnderPressure(f, sink) {
    const MAX_ATTEMPTS = 5;
    const BACKOFF_BASE_MS = 5_000;
    const TARGET = 'over-age-session';
    let attempts = 0;
    let nextAllowedAtMs = 0;
    let breakerOpen = false;
    return {
      tick() {
        sink.considered += 1;
        if (breakerOpen) return; // P19 breaker — gave up LOUDLY (in real code: one aggregated attention item)
        if (f.clock.nowMs() < nextAllowedAtMs) return; // dwell inside the backoff window
        sink.emit({ verb: 'requestKill', target: TARGET });
        attempts += 1;
        if (f.targetAlwaysRejects()) {
          // Exponential backoff, then trip the breaker at the cap.
          nextAllowedAtMs = f.clock.nowMs() + BACKOFF_BASE_MS * 2 ** attempts;
          if (attempts >= MAX_ATTEMPTS) breakerOpen = true;
        }
      },
    };
  },
};

/**
 * promise-beacon-notify — the ⏳ "still on it, no new output" heartbeat that
 * used to fire every tick (zero-information spam). Models the honest-progress
 * fix (PromiseBeacon suppressUnchangedHeartbeats): under the worst case
 * (everySessionBusy with NO genuine new progress ever), the progress heartbeat
 * is SUPPRESSED every tick -> count 0, horizon-independent. (The sparse
 * once-per-interval liveness line is the SEPARATE eternal-sentinel controller
 * below — a rate-floored constant-cost heartbeat, not a bounded action.)
 */
const promiseBeaconNotify: SelfActionController = {
  id: 'promise-beacon-notify',
  actionVerb: 'beacon-notify',
  models: 'src/monitoring/PromiseBeacon.ts (suppressUnchangedHeartbeats — progress-only heartbeat)',
  boundK: 1,
  perTargetBoundK: 1,
  ticks: 20,
  tickMs: 20 * 60_000, // 20 min/tick (the relaxed base cadence)
  makeUnderPressure(f, sink) {
    return {
      tick() {
        sink.considered += 1;
        // The worst case: work is happening (everySessionBusy) but the terminal
        // frame never CHANGES — the exact "busy long task looks identical to a
        // frozen one" the fix addresses. No new progress -> suppress. Emitting a
        // filler line here is precisely the zero-info spam the fix removed.
        const hasGenuineNewProgress = false;
        if (hasGenuineNewProgress) {
          sink.emit({ verb: 'notify', target: 'topic-progress' });
        }
      },
    };
  },
};

/**
 * liveness-heartbeat — a DECLARED Eternal Sentinel (P19 exemption). A sparse,
 * constant-cost "I'm alive" line on a rate FLOOR (the once-per-60m liveness the
 * PromiseBeacon still emits). It is EXEMPT from a total-count bound by design;
 * the ratchet asserts the P19 four conditions instead — a constant per-attempt
 * cost + a rate floor that prevents accumulation (emits never exceed
 * elapsed/rateFloorMs). This exercises the ratchet's eternal-sentinel path so
 * the exemption is a tested contract, not prose.
 */
const livenessHeartbeat: SelfActionController = {
  id: 'liveness-heartbeat',
  actionVerb: 'liveness-notify',
  models: 'src/monitoring/PromiseBeacon.ts (beaconLivenessIntervalMs — sparse once-per-interval liveness line)',
  boundK: Number.POSITIVE_INFINITY, // exempt — bounded by the rate floor, not a total count
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 24,
  tickMs: 20 * 60_000, // 20 min/tick
  eternalSentinel: { reason: 'sparse constant-cost liveness heartbeat', rateFloorMs: 60 * 60_000 },
  makeUnderPressure(f, sink) {
    const RATE_FLOOR_MS = 60 * 60_000;
    let lastEmitAtMs = Number.NEGATIVE_INFINITY;
    return {
      tick() {
        sink.considered += 1;
        // Constant per-attempt cost (one fixed-size line) + a hard rate floor:
        // emit ONLY if at least RATE_FLOOR_MS has elapsed since the last line.
        if (f.clock.nowMs() - lastEmitAtMs >= RATE_FLOOR_MS) {
          sink.emit({ verb: 'notify', target: 'topic-liveness' });
          sink.emitTimesMs.push(f.clock.nowMs());
          lastEmitAtMs = f.clock.nowMs();
        }
      },
    };
  },
};

/**
 * external-hog-kill-breaker — the External-Hog sentinel's respawn brake
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §6 — the
 * #863 reaper-kill-loop shape: 17,503 identical requests is the ancestor
 * incident). Unlike the other entries this model drives the REAL pure brake
 * (`isBreakerTripped`/`recordKill` from ExternalHogKillLedger) rather than a
 * re-model — so the ratchet proves the shipped code converges, not a copy.
 * The pinned worst case: the SAME respawn-surviving zombie signature comes
 * back sustained-hot on EVERY 60s scan (something keeps relaunching it — the
 * targetAlwaysRejects shape: each kill "succeeds" but never sticks). The
 * breaker permits K=3 kills of that signature within the rolling window, then
 * STOPS killing it (in real code: one deduped degradation "keeps respawning —
 * may be managed"; the §4 observability floor still surfaces the hog). The
 * rolling window means the true steady state is a RATE bound (≤K per window
 * per signature), with the ledger pruned to retention so state stays bounded;
 * the horizon here (2N = 60 min = exactly one window) proves the within-window
 * settle exactly: kills 3, then flat.
 */
const externalHogKillBreaker: SelfActionController = {
  id: 'external-hog-kill-breaker',
  actionVerb: 'kill',
  models: 'src/monitoring/ExternalHogKillLedger.ts (respawn breaker driven by the ExternalHogScanTick kill path — real pure functions, not a re-model)',
  boundK: 3,
  perTargetBoundK: 3, // legitimately the SAME respawning signature, bounded by the window breaker (not a ping-pong)
  ticks: 30,
  tickMs: 60_000, // the real scan cadence; 2N ticks span 3,540,000 ms < the 1h window, so the settle check is exact
  makeUnderPressure(f, sink) {
    const WINDOW_MS = 3_600_000; // the shipped default (killLedgerMaxPerSignaturePerHour window)
    const MAX_PER_WINDOW = 3; // the shipped default K
    const RETENTION_MS = 3_600_000; // config wires retention >= window (recordKill precondition)
    const KEY = 'sha256:code-helper-plugin|--user-data-dir=/Users/x/Library/Application Support/Code';
    const CLASS_ID = 'editor-extension-host';
    let ledger = EMPTY_KILL_LEDGER;
    return {
      tick() {
        sink.considered += 1;
        // Sustained pressure: the signature is back and hot every scan, forever.
        if (!f.targetAlwaysRejects()) return;
        const nowMs = f.clock.nowMs();
        const opts = { nowMs, windowMs: WINDOW_MS, maxPerWindow: MAX_PER_WINDOW, keyIsVolatile: false };
        if (isBreakerTripped(ledger, KEY, CLASS_ID, opts)) return; // the brake: stop fighting the respawner
        sink.emit({ verb: 'kill', target: KEY });
        ledger = recordKill(ledger, { key: KEY, classId: CLASS_ID, atMs: nowMs }, RETENTION_MS, nowMs);
      },
    };
  },
};

/**
 * Routing-spend reserve-expiry sweep (routing-control-room-spend Increment B,
 * src/core/MeteredSpendLedger.ts sweepExpired + the 5-min AgentServer cadence).
 * Convergence shape: the terminal state machine IS the brake — an expired
 * reserve can never re-expire (first terminal transition wins), and the sweep
 * creates no reserves of its own. Under the pinned worst case (a burst of
 * reserves whose settles never arrive), the sweep expires each exactly ONCE and
 * then converges to zero emissions forever: steady state is bounded by the
 * (finite) stale pool, per-target bound 1 by construction.
 */
const meteredReserveExpirySweep: SelfActionController = {
  id: 'metered-reserve-expiry-sweep',
  actionVerb: 'expire-reserve-kill', // 'kill' detector token; the swept reserve is terminally closed
  models: 'src/core/MeteredSpendLedger.ts (sweepExpired; idempotent terminal reserve→expired) + src/server/AgentServer.ts 5-min cadence',
  boundK: 3, // exactly the 3 stale reserves in the fixture — never more
  perTargetBoundK: 1, // terminal: one expire per reserveId, ever
  ticks: 50,
  tickMs: 5 * 60_000, // the real sweep cadence
  makeUnderPressure(f, sink) {
    const TTL_MS = 15 * 60_000;
    // The pinned worst case: three reserves booked at t0 whose settles NEVER arrive.
    const reserves = [
      { id: 'rsv-1', reservedAtMs: 0, state: 'reserved' as 'reserved' | 'expired' },
      { id: 'rsv-2', reservedAtMs: 0, state: 'reserved' as 'reserved' | 'expired' },
      { id: 'rsv-3', reservedAtMs: 0, state: 'reserved' as 'reserved' | 'expired' },
    ];
    return {
      tick() {
        sink.considered += 1;
        for (const r of reserves) {
          if (r.state !== 'reserved') continue; // terminal — the brake
          if (f.clock.nowMs() - r.reservedAtMs <= TTL_MS) continue;
          r.state = 'expired';
          sink.emit({ verb: 'expire-reserve-kill', target: r.id });
        }
      },
    };
  },
};

/**
 * Routing-spend stale-price alert cadence (routing-control-room-spend Increment
 * B, src/core/SpendAlertResolver.ts emit + the 6h AgentServer staleCheck).
 * Convergence shape: the edge latch is the brake — a CONFIRMED emission latches
 * its dedupe key for the 24h re-arm window, so under permanently-stale pricing
 * (the pressure that never clears) the loop converges to one alert per door per
 * day: a declared Eternal Sentinel with a 24h rate floor, never a flood.
 */
const spendStalePriceAlert: SelfActionController = {
  id: 'spend-stale-price-alert',
  actionVerb: 'stale-price-notify',
  models: 'src/core/SpendAlertResolver.ts (emit — edge latch on CONFIRMED delivery, 24h re-arm) + src/server/AgentServer.ts 6h staleCheck cadence',
  boundK: 3, // 3 emissions across the ~2.1-day horizon = 1 per 24h window (rate floor), one door
  perTargetBoundK: 3,
  ticks: 8, // 8 × 6h = 48h+2 ticks horizon; 2N=16 ticks (~4 days) still settles at the daily rate
  tickMs: 6 * 60 * 60_000, // the real 6h cadence
  eternalSentinel: {
    reason:
      'Stale pricing changes money ADMISSION behavior (C5-5) — the alarm must re-arm daily while the condition persists (silent staleness is the failure this closes); the 24h edge latch is the rate floor.',
    rateFloorMs: 24 * 60 * 60_000,
  },
  makeUnderPressure(f, sink) {
    const REARM_MS = 24 * 60 * 60_000;
    let lastConfirmedAtMs = -Infinity;
    return {
      tick() {
        sink.considered += 1;
        // The pressure: the door's price is stale FOREVER (never clears).
        if (f.clock.nowMs() - lastConfirmedAtMs < REARM_MS) return; // the latch — suppressed
        sink.emit({ verb: 'stale-price-notify', target: 'openrouter-api' });
        lastConfirmedAtMs = f.clock.nowMs(); // latch ONLY on confirmed delivery
      },
    };
  },
};

/**
 * Routing-spend door-dark escalation (routing-control-room-spend Increment C,
 * src/core/SpendAlertEmitters.ts onChainExhausted). Convergence shape: a
 * per-episode-bucket attempt budget (= chain length) + widening backoff + the
 * dispatcher's edge latch downstream. Under a PERMANENTLY dark chain (the
 * pressure that never clears) emissions converge to the episode budget per
 * bucket — never a per-exhaustion flood.
 */
const spendDoorDarkBrakes: SelfActionController = {
  id: 'spend-door-dark-brakes',
  actionVerb: 'door-dark-notify',
  models: 'src/core/SpendAlertEmitters.ts (onChainExhausted — episode budget = chain length, widening backoff, flapping wording)',
  boundK: 6, // 2 episode buckets × chain length 3 over the horizon
  perTargetBoundK: 6, // same chain each time — bounded by the episode budgets, not a ping-pong
  ticks: 145, // 145 × 5min ≈ 12.1h — crosses one 6h episode-bucket boundary
  tickMs: 5 * 60_000,
  eternalSentinel: {
    reason:
      'A permanently dark chain must keep surfacing at a bounded rate while it persists (whole-chain exhaustion is gated work failing closed); the episode-bucket budget is the rate floor.',
    rateFloorMs: 2 * 60 * 60_000, // ≥3 emissions per 6h bucket ⇒ one per ≤2h worst case
  },
  makeUnderPressure(f, sink) {
    const CHAIN_LENGTH = 3;
    const BACKOFF_BASE_MS = 5 * 60_000;
    const BUCKET_MS = 6 * 60 * 60_000;
    let bucket = -1;
    let attempts = 0;
    let nextAllowedAtMs = 0;
    return {
      tick() {
        sink.considered += 1;
        // The pressure: EVERY tick is a whole-chain exhaustion that never heals.
        const nowMs = f.clock.nowMs();
        const b = Math.floor(nowMs / BUCKET_MS);
        if (b !== bucket) {
          bucket = b;
          attempts = 0;
          nextAllowedAtMs = 0;
        }
        if (attempts >= CHAIN_LENGTH) return; // episode budget spent — the brake
        if (nowMs < nextAllowedAtMs) return; // widening backoff — the spacing brake
        attempts += 1;
        nextAllowedAtMs = nowMs + BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
        sink.emit({ verb: 'door-dark-notify', target: 'chain-JUDGE' });
      },
    };
  },
};

/**
 * Routing-spend fallback-spike digest (Increment C, SpendAlertEmitters
 * onFallbackServed). Convergence shape: steady-state fallback churn is
 * jsonl-only; ONE digest line fires exactly at the hourly ceiling crossing —
 * the hour bucket is the latch, so sustained churn converges to one emission
 * per hour (eternal-sentinel rate floor), never per-fallback noise.
 */
const spendFallbackSpike: SelfActionController = {
  id: 'spend-fallback-spike',
  actionVerb: 'fallback-spike-notify',
  models: 'src/core/SpendAlertEmitters.ts (onFallbackServed — hourly ceiling edge, one per hour bucket)',
  boundK: 3, // 3 hour-buckets over the horizon → at most one each
  perTargetBoundK: 3,
  ticks: 180, // 180 × 1min = 3h of sustained churn
  tickMs: 60_000,
  eternalSentinel: {
    reason:
      'Sustained fallback churn above the ceiling keeps surfacing once per hour bucket while it persists (primaries degrading is operator-relevant); the bucket edge is the rate floor.',
    rateFloorMs: 60 * 60_000,
  },
  makeUnderPressure(f, sink) {
    const CEILING = 60;
    let hour = -1;
    let count = 0;
    return {
      tick() {
        sink.considered += 1;
        // The pressure: a fallback serves EVERY MINUTE, forever (rate ≥ ceiling).
        const h = Math.floor(f.clock.nowMs() / 3_600_000);
        if (h !== hour) {
          hour = h;
          count = 0;
        }
        count += 1;
        if (count === CEILING) sink.emit({ verb: 'fallback-spike-notify', target: `hour-${h}` });
      },
    };
  },
};

/**
 * Routing-spend cap-approach thresholds (Increment C, SpendAlertEmitters
 * checkCapApproach). Convergence shape: edge-triggered per (capKind,
 * threshold, window) with the dispatcher latch — a key parked at 90% of both
 * caps emits AT MOST 4 notices per window (2 kinds × 2 thresholds), re-armed
 * only by the window rolling (daily) — never per-admit noise.
 */
const spendCapApproach: SelfActionController = {
  id: 'spend-cap-approach',
  actionVerb: 'cap-approach-notify',
  models:
    'src/core/SpendAlertEmitters.ts (checkCapApproach — 50/80 on both caps, per-window dedupe via the dispatcher latch). ' +
    'The FEEDBACK-driven surface is the edge latch (modeled here, horizon-independent); the daily window additionally ' +
    're-arms on the CALENDAR day boundary — clock-driven, not feedback-driven, bounded at 2 notices/key/day by construction.',
  boundK: 4, // 2 kinds × 2 thresholds — the latch bound, horizon-independent
  perTargetBoundK: 1, // each (kind, threshold, window) key emits ONCE, ever
  ticks: 96, // 96 × 5min = 8h of admits with committed parked ≥80% (inside one window)
  tickMs: 5 * 60_000,
  makeUnderPressure(f, sink) {
    const latched = new Set<string>();
    return {
      tick() {
        sink.considered += 1;
        // The pressure: every admit lands with committed at 90% of BOTH caps,
        // inside one window (the calendar re-arm is out of feedback scope).
        for (const capKind of ['daily', 'lifetime'] as const) {
          for (const threshold of [0.5, 0.8]) {
            const key = `spend-approach:k1:${capKind}:${threshold}:w1`;
            if (latched.has(key)) continue; // the dispatcher's edge latch — the brake
            latched.add(key);
            sink.emit({ verb: 'cap-approach-notify', target: key });
          }
        }
      },
    };
  },
};

/**
 * Routing-spend provider-reconciliation drift alert (Layer 1c,
 * src/monitoring/ProviderReconciliationSweep.ts run() → the Increment-C
 * dispatcher). Convergence shape: the sweep itself has NO feedback loop (its
 * output never changes its input — prices and provider reports are external
 * facts); its only self-action is the drift alert, deduped by the dispatcher
 * latch per (keyRef, door, driftBucket) with a 24h re-arm. Under a PERMANENTLY
 * drifting pair (the pressure that never clears) emissions converge to one per
 * re-arm window — an eternal sentinel with a 24h rate floor.
 */
const spendReconSweep: SelfActionController = {
  id: 'spend-recon-sweep',
  actionVerb: 'recon-drift-notify',
  models: 'src/monitoring/ProviderReconciliationSweep.ts (cadenced read-only comparator) + the Increment-C dispatcher latch (24h re-arm per (keyRef, door, driftBucket))',
  boundK: 3, // 3 re-arm windows over the horizon → one each
  perTargetBoundK: 3,
  ticks: 12, // 12 × 6h sweep cadence = 3 days of permanent drift
  tickMs: 6 * 60 * 60_000,
  eternalSentinel: {
    reason:
      'A permanently drifting (provider ≫ booked) pair must keep surfacing daily while it persists — stale pricing feeds the PIN promotion path; the dispatcher 24h latch is the rate floor.',
    rateFloorMs: 24 * 60 * 60_000,
  },
  makeUnderPressure(f, sink) {
    const REARM_MS = 24 * 60 * 60_000;
    let lastEmitAtMs = -Infinity;
    return {
      tick() {
        sink.considered += 1;
        // The pressure: every sweep pass finds the SAME +20% drift, forever.
        if (f.clock.nowMs() - lastEmitAtMs < REARM_MS) return; // the dispatcher latch
        lastEmitAtMs = f.clock.nowMs();
        sink.emit({ verb: 'recon-drift-notify', target: 'metered_openrouter_bench:openrouter-api' });
      },
    };
  },
};

export const SELF_ACTION_CONTROLLERS: SelfActionController[] = [
  spendReconSweep,
  spendDoorDarkBrakes,
  spendFallbackSpike,
  spendCapApproach,
  proactiveSwapMonitor,
  ageKillBackoff,
  promiseBeaconNotify,
  livenessHeartbeat,
  externalHogKillBreaker,
  meteredReserveExpirySweep,
  spendStalePriceAlert,
];
