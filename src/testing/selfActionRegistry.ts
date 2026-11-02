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

import { WorkAdmission } from '../core/workAdmission.js';
import { MAX_GUARD_REPLACEMENTS, RESPAWNS_PER_REQUEST, decideGuardReplacement, decideLockedRespawn } from '../core/DesktopLockedController.js';
import { OverloadShedPlanner, DEFAULT_OVERLOAD_SHED } from '../core/OverloadShedPlanner.js';
import { PlacementExecutor } from '../core/PlacementExecutor.js';
import type { MachineCapacity } from '../core/types.js';
import { HostSpawnSemaphore } from '../core/hostSpawnSemaphore.js';
import fs from 'node:fs';
import os from 'node:os';
import { checkThrowawayExpiry, MAX_TEARDOWN_ATTEMPTS } from '../core/ThrowawayAgentGuard.js';
import path from 'node:path';
import { decideConnectEnable, CONNECT_ENABLE_RESTART_COOLDOWN_MS, type ConnectEnableRequestRecord } from '../threadline/connectEnable.js';
import { EMPTY_KILL_LEDGER, isBreakerTripped, recordKill } from '../monitoring/ExternalHogKillLedger.js';
import { advanceBrowserRecovery, type BrowserRecoveryState } from '../messaging/telegram-origin/OriginBrowserRecovery.js';
import { planAdoption, readSystemTopicIds, withAdoptionBrake, MAX_ADOPTS_PER_KIND_PER_BOOT, SYSTEM_TOPIC_ADOPTION_INTERVAL_MS } from '../messaging/SystemTopicAdoption.js';
import { SYSTEM_TOPIC_STATE_KEYS } from '../core/StateManager.js';
import { StageAdvancer, MAX_TARGET_REDS_PER_COMMIT, type SessionPoolStage } from '../core/StageAdvancer.js';
import { SessionPoolRolloutDriver } from '../core/SessionPoolRolloutDriver.js';
import type { SessionPoolE2EResultStore, StageE2EResult } from '../core/SessionPoolE2EResultStore.js';
import { decideAttentionExpiry, planAttentionSupersessions, resolveAttentionLifecycleConfig, type AttentionLifecycleItem } from '../core/AttentionLifecycle.js';
import { MAIN_FAIR_SHARE_MS, decideMergeHandoff, decideStart, decideStarved, decideVerifyRetry } from '../localVerify/LocalVerifyService.js';
import { decideIsolationRerun, type ParsedLaneReport } from '../localVerify/laneReport.js';
import { MAIN_VERIFY_LIMITS, decideMainEnqueue, decideMainErrorRetry, decideMainHeadEnqueue, type MainHeadObservation } from '../localVerify/mainHealth.js';
import { LOCAL_VERIFY_LIMITS } from '../localVerify/policy.js';
import { decideLoginExpiredSwap, INTERACTIVE_LOGIN_SWAP_COOLDOWN_MS, INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS } from '../core/InteractiveLoginExpiredRecovery.js';
import { nextBreakerState, RECONCILE_LIMITS } from '../core/ReplicatedStoreReconciler.js';
import { RECONCILER_LIMITS, admitStatusPost, nextPostRetry, orderSubmissions, passBackoffDelay, postRetryDue } from '../localVerify/StatusReconciler.js';

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
  /** Explicit restart-surviving state; restart callbacks receive no prior controller instance. */
  durableState: Map<string, unknown>;
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
  /**
   * PARSEABLE path binding for the emit-without-admit usage-scan lint
   * (unified-self-action-backpressure companion §9): the registry-named
   * source FILE licensed to declare this controller's marker + mint its
   * governor handle. Unlike `models:` (prose-annotated), this field is a
   * bare repo-relative path the lint greps — the promotion of the models:
   * pointer from documentation to a lint-asserted binding (spec SEC6-4).
   */
  modelsPath: string;
  /**
   * The named EXTERNAL give-up authority for an exempt-lane member (the
   * respawn-recovery / eternalSentinel count-exempt lanes — spec ADV5-3):
   * the cap that owns this controller's give-up, which the ratchet fixture
   * drives to its trip point. Required for every eternalSentinel entry.
   */
  delegatedGiveUp?: string;
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
  /** Every controller must classify its restart boundary; omission is a ratchet failure. */
  restartPosture:
    | { pressureSurvives: false; resetSafeReason: string }
    | { pressureSurvives: true; restartUnderPressure: (f: PressureFixture, sink: ActionSink) => { tick(): void } };
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
  modelsPath: 'src/core/ProactiveSwapMonitor.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The all-hot/projected-load refusal is stateless and recomputed after boot; reset cannot create an allowed swap.' },
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
  models: 'src/core/SessionManager.ts (age-limit kill-request; AgeKillBackoff — P19 backoff + breaker)',
  modelsPath: 'src/core/SessionManager.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Server restart begins a new reaper episode and re-reads protection/age before any kill request.' },
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
/**
 * codex-arm-session-sweep — CodexArmSessionSweeper's kill path (spec
 * codex-arm-session-leak-and-sweeper §3.6-3.7). Under the worst case (every kill is
 * refused, the orphan population never shrinks) each candidate is attempted at most
 * maxKillFailuresPerSession (3) times and then never again, and a pass is capped at
 * maxKillsPerPass attempts — so the total over ANY horizon is 3 × candidates: horizon-
 * independent, which is the convergence this registry proves rather than the prose
 * arithmetic the spec also carries. Modelled with 10 standing candidates.
 */
const codexArmSessionSweep: SelfActionController = {
  id: 'codex-arm-session-sweep',
  actionVerb: 'sweep-kill',
  models: 'src/monitoring/CodexArmSessionSweeper.ts (killSession — per-session kill-failure brake + per-pass attempt cap)',
  modelsPath: 'src/monitoring/CodexArmSessionSweeper.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'A restart forgets the per-session failure counts; the next pass re-reads tmux and re-corroborates every candidate before any kill, and the per-pass cap bounds the first pass regardless.' },
  boundK: 30,         // 10 candidates × 3 attempts each, then never again
  perTargetBoundK: 3, // maxKillFailuresPerSession
  ticks: 40,          // 40 passes; N=40 and 2N=80 both settle at 30
  tickMs: 10 * 60_000, // one pass every 10 min (sweepIntervalMs)
  eternalSentinel: undefined,
  makeUnderPressure(f, sink) {
    const MAX_FAILURES = 3;
    const MAX_ATTEMPTS_PER_PASS = 50;
    const candidates = Array.from({ length: 10 }, (_, i) => `instar-codex-arm-${i}`);
    const failures = new Map<string, number>();
    return {
      tick() {
        sink.considered += 1; // one PASS considered per tick (the fixture's contract)
        let attempted = 0;
        for (const name of candidates) {
          if ((failures.get(name) ?? 0) >= MAX_FAILURES) continue; // kill-failures-exhausted → kept
          if (attempted >= MAX_ATTEMPTS_PER_PASS) continue;         // per-pass-cap → kept
          attempted += 1;
          sink.emit({ verb: 'killSession', target: name });
          if (f.targetAlwaysRejects()) failures.set(name, (failures.get(name) ?? 0) + 1);
          else failures.delete(name);
        }
      },
    };
  },
};

/** desktop-relock-guard-replacement: the sweep replaces a dead relock guard for
 * one duty, then fails that duty loudly. The count lives on the durable marker. */
const desktopRelockGuardReplacement: SelfActionController = {
  id: 'desktop-relock-guard-replacement',
  actionVerb: 'respawn',
  models: 'src/core/DesktopLockedController.ts (replaceGuard — decideGuardReplacement cap per duty)',
  modelsPath: 'src/core/DesktopLockedController.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The count is on the durable marker, so a restart cannot reset it, and a marker from another boot closes.' },
  boundK: MAX_GUARD_REPLACEMENTS,
  perTargetBoundK: MAX_GUARD_REPLACEMENTS,
  ticks: 40,
  tickMs: 10_000,
  eternalSentinel: undefined,
  makeUnderPressure(_f, sink) {
    let replacements = 0;
    return {
      tick() {
        sink.considered += 1;
        if (decideGuardReplacement(replacements) === 'give-up') return;
        replacements += 1;
        sink.emit({ verb: 'respawn', target: 'relock-guard' });
      },
    };
  },
};

/** desktop-locked-helper-respawn: a lock ends the helper; Node respawns it a
 * bounded number of times per request, however often the state flaps. */
const desktopLockedHelperRespawn: SelfActionController = {
  id: 'desktop-locked-helper-respawn',
  actionVerb: 'respawn',
  models: 'src/core/DirectDesktopAccess.ts (spendRespawn — decideLockedRespawn, per change and per request)',
  modelsPath: 'src/core/DirectDesktopAccess.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'A restart revokes every grant, so no request survives to respawn for.' },
  boundK: RESPAWNS_PER_REQUEST,
  perTargetBoundK: RESPAWNS_PER_REQUEST,
  ticks: 40,
  tickMs: 1_000,
  eternalSentinel: undefined,
  makeUnderPressure(_f, sink) {
    let thisChange = 0;
    let total = 0;
    return {
      tick() {
        sink.considered += 1;
        thisChange = 0; // Worst case: the state flaps on every tick.
        if (!decideLockedRespawn(thisChange, total)) return;
        thisChange += 1;
        total += 1;
        sink.emit({ verb: 'respawn', target: 'desktop-helper' });
      },
    };
  },
};

const promiseBeaconNotify: SelfActionController = {
  id: 'promise-beacon-notify',
  actionVerb: 'beacon-notify',
  models: 'src/monitoring/PromiseBeacon.ts (suppressUnchangedHeartbeats — progress-only heartbeat)',
  modelsPath: 'src/monitoring/PromiseBeacon.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The unchanged-progress refusal is stateless; reconstruction still observes no genuine progress and emits zero.' },
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
  modelsPath: 'src/monitoring/PromiseBeacon.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'A process restart begins a new liveness epoch; one new constant-cost heartbeat is the declared signal.' },
  delegatedGiveUp: 'the hard rateFloorMs (60 min) — emits can never exceed elapsed/rateFloorMs',
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
 * promise-beacon-internal-cadence — a DECLARED Eternal Sentinel for the
 * output-disabled bookkeeping heartbeat. The real controller persists
 * `lastHeartbeatAt` and schedules from that durable anchor through the
 * configured cadence clamped to a 60s minimum. Quiet hours and the user-output
 * LLM budget do not govern this internal write; ownership still does.
 */
const promiseBeaconInternalCadence: SelfActionController = {
  id: 'promise-beacon-internal-cadence',
  actionVerb: 'heartbeat-refresh',
  models: 'src/monitoring/PromiseBeacon.ts (output-disabled lastHeartbeatAt refresh + clampCadence minimum)',
  modelsPath: 'src/monitoring/PromiseBeacon.ts',
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makePromiseBeaconInternalCadenceLoop(f, sink),
  },
  delegatedGiveUp: 'the hard minCadenceMs floor (60s by default) — durable refreshes cannot exceed elapsed/minCadenceMs',
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 20,
  tickMs: 30_000,
  eternalSentinel: { reason: 'constant-cost durable internal liveness refresh', rateFloorMs: 60_000 },
  makeUnderPressure: (f, sink) => makePromiseBeaconInternalCadenceLoop(f, sink),
};

function makePromiseBeaconInternalCadenceLoop(
  f: PressureFixture,
  sink: ActionSink,
): { tick(): void } {
  const LAST_AT = 'promise-beacon-internal-cadence:last-at';
  const RATE_FLOOR_MS = 60_000;
  return {
    tick() {
      sink.considered += 1;
      const lastAt = (f.durableState.get(LAST_AT) as number | undefined) ?? Number.NEGATIVE_INFINITY;
      if (f.clock.nowMs() - lastAt < RATE_FLOOR_MS) return;
      sink.emit({ verb: 'heartbeat-refresh', target: 'commitment-liveness' });
      sink.emitTimesMs.push(f.clock.nowMs());
      f.durableState.set(LAST_AT, f.clock.nowMs());
    },
  };
}

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
  modelsPath: 'src/monitoring/ExternalHogSentinel.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The real controller reloads its durable kill ledger; this model starts from one already-hydrated episode.' },
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
  modelsPath: 'src/core/MeteredSpendLedger.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Expiry is a one-shot durable row transition; reconstruction re-reads the handled row.' },
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
  modelsPath: 'src/core/SpendAlertResolver.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The alert latch is persisted with the spend snapshot and rehydrated.' },
  delegatedGiveUp: 'the 24h confirmed-delivery edge latch (dispatcher re-arm window)',
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
  modelsPath: 'src/core/SpendAlertEmitters.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Door-dark brake state is derived from the durable provider report window on boot.' },
  delegatedGiveUp: 'the per-episode-bucket attempt budget (= chain length) + widening backoff',
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
  modelsPath: 'src/core/SpendAlertEmitters.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Fallback-spike episodes are keyed to durable metric windows, so restart re-enters the same episode.' },
  delegatedGiveUp: 'the hourly ceiling-crossing bucket edge (one digest line per hour bucket)',
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
  modelsPath: 'src/core/SpendAlertEmitters.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Cap-approach notification state is persisted with the governance snapshot.' },
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
  modelsPath: 'src/monitoring/ProviderReconciliationSweep.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Reconciliation consumes durable unsettled rows idempotently; restart cannot recreate a consumed row.' },
  delegatedGiveUp: 'the dispatcher 24h latch per (keyRef, door, driftBucket)',
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

const evolutionActionExpirySweep: SelfActionController = {
  id: 'evolution-action-expiry-sweep',
  actionVerb: 'reap-expired-actions',
  models: 'src/core/EvolutionManager.ts (scheduled stale pending-action expiry; survivor-set brake)',
  modelsPath: 'src/core/EvolutionManager.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Expiry marks the durable action terminal; reconstruction sees terminal state.' },
  boundK: 3,
  perTargetBoundK: 1,
  ticks: 20,
  tickMs: 6 * 60 * 60_000,
  makeUnderPressure(_f, sink) {
    const eligible = new Set(['stale-a', 'stale-b', 'stale-c']);
    return {
      tick() {
        sink.considered += 1;
        for (const target of eligible) {
          sink.emit({ verb: 'reap-expired-actions', target });
        }
        eligible.clear(); // Durable removal is the brake: later sweeps see no survivors.
      },
    };
  },
};

/**
 * owner-dark-notice — the OwnerDarkLadder rung-3 notice under sustained
 * pressure (ownership-gated-spawn §3.3/§5 Capacity Safety): an owner machine
 * dark FOREVER while inbound messages keep arriving for 3 topics every tick.
 * Convergence shape: ONE notice per (topic, outage-episode) + the per-topic
 * cooldown — sustained pressure converges to exactly one emit per topic, and a
 * longer horizon adds NOTHING while the episode persists (the episode set is
 * the latch; owner recovery is the only re-arm).
 */
const ownerDarkNotice: SelfActionController = {
  id: 'owner-dark-notice',
  actionVerb: 'owner-dark-notify',
  models: 'src/core/OwnerDarkLadder.ts (handleOwnerDark — episode dedupe + noticeCooldownMs)',
  modelsPath: 'src/core/OwnerDarkLadder.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Notice cadence is derived from the durable owner-dark ladder record.' },
  boundK: 3, // 3 topics → at most one notice each while the episode persists
  perTargetBoundK: 1,
  ticks: 120,
  tickMs: 60_000, // 2h of sustained inbound while the owner stays dark
  makeUnderPressure(f, sink) {
    const noticed = new Set<string>();
    return {
      tick() {
        sink.considered += 1;
        // The pressure: every tick, a message arrives for each of 3 topics
        // whose owner is dark. The episode never closes (owner never recovers).
        for (const topic of ['t1', 't2', 't3']) {
          if (noticed.has(topic)) continue; // ONE per (topic, episode) — the latch
          noticed.add(topic);
          sink.emit({ verb: 'owner-dark-notify', target: topic });
        }
      },
    };
  },
};

/**
 * duplicate-converge-write — the DuplicateSessionReconciler's convergence CAS
 * under sustained pressure (ownership-gated-spawn §3.2/§5 Capacity Safety): a
 * topic that RE-duplicates immediately after every repair (the pathological
 * flap). Convergence shape: 3 convergence attempts per episode (then escalate,
 * not retry) × the P19 breaker (3 episodes per 24h window → the topic stops
 * being auto-reconciled entirely) — sustained flap converges to ≤9 writes and
 * then silence + ONE attention item, never an unbounded repair loop.
 */
const duplicateConvergeWrite: SelfActionController = {
  id: 'duplicate-converge-write',
  actionVerb: 'record-converge',
  models: 'src/monitoring/DuplicateSessionReconciler.ts (convergenceAttempts cap + breakerThreshold/breakerWindowMs clamp)',
  modelsPath: 'src/monitoring/DuplicateSessionReconciler.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Convergence writes a durable terminal episode marker and reloads it before another write.' },
  boundK: 9, // 3 episodes × 3 attempts, then the breaker clamps the topic
  perTargetBoundK: 9,
  ticks: 90,
  tickMs: 60_000, // 1.5h of sustained flap — well inside the 24h breaker window
  makeUnderPressure(f, sink) {
    const BREAKER_THRESHOLD = 3;
    const ATTEMPTS_PER_EPISODE = 3;
    let episodes = 0;
    let attempts = 0;
    let episodeOpen = false;
    return {
      tick() {
        sink.considered += 1;
        // The pressure: the duplicate re-forms EVERY tick. Episode counting
        // mirrors bumpBreaker (episodes bump at open); attempts mirror the
        // per-episode convergence cap; the breaker clamps at the threshold.
        if (episodes >= BREAKER_THRESHOLD && !episodeOpen) return; // clamped — the brake
        if (!episodeOpen) {
          episodes += 1;
          episodeOpen = true;
          attempts = 0;
        }
        if (attempts >= ATTEMPTS_PER_EPISODE) {
          // attempts exhausted → escalate (not modeled as an emit) + episode closes
          episodeOpen = false;
          return;
        }
        attempts += 1;
        sink.emit({ verb: 'record-converge', target: 'topic-flap' });
        // The repair "succeeds" then the duplicate re-forms → episode closes,
        // a fresh one opens next tick (until the breaker clamps).
        if (attempts >= ATTEMPTS_PER_EPISODE) episodeOpen = false;
      },
    };
  },
};

/**
 * burn-alert-terminal-delivery — a permanently deleted configured Telegram
 * topic under endless detector pressure. The first terminal response latches
 * the topic; every later alert bypasses that target for durable Attention.
 * Therefore primary sends settle at exactly one, independent of horizon.
 */
const burnAlertTerminalDelivery: SelfActionController = {
  id: 'burn-alert-terminal-delivery',
  actionVerb: 'burn-alert-sendToTopic',
  models: 'src/monitoring/BurnAlertDelivery.ts (terminal topic quarantine)',
  modelsPath: 'src/monitoring/BurnAlertDelivery.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Terminal topic quarantine is durable and reloaded, so the deleted target remains suppressed.' },
  boundK: 1,
  perTargetBoundK: 1,
  ticks: 60,
  tickMs: 60 * 60_000,
  makeUnderPressure(_f, sink) {
    let terminal = false;
    return {
      tick() {
        sink.considered += 1;
        if (terminal) return;
        sink.emit({ verb: 'burn-alert-sendToTopic', target: 'deleted-topic' });
        terminal = true;
      },
    };
  },
};

/**
 * The presenting restart-reset class: Stop-gate timeout feedback was bounded
 * inside one process, but routine releases reconstructed the in-memory breaker
 * and minted two fresh degradation submissions. This model guards the feedback
 * emission bound (not the low-rate half-open health probe): durable failure state
 * survives every reconstruction, so unchanged provider pressure emits at most
 * threshold-1 timeout feedback records across the whole restart storm.
 */
const stopGateAuthorityProbe: SelfActionController = {
  id: 'stop-gate-authority-probe',
  actionVerb: 'degradation-notify',
  models: 'src/core/UnjustifiedStopGate.ts + src/core/StopGateDb.ts (durable authority breaker suppresses restart-minted timeout feedback)',
  modelsPath: 'src/core/UnjustifiedStopGate.ts',
  boundK: 2,
  perTargetBoundK: 2,
  ticks: 20,
  tickMs: 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) {
      return stopGateAuthorityProbe.makeUnderPressure(f, sink);
    },
  },
  makeUnderPressure(f, sink) {
    const tick = () => {
      sink.considered += 1;
      const failures = Number(f.durableState.get('stop-gate-failures') ?? 0);
      if (failures >= 3) return;
      const next = failures + 1;
      f.durableState.set('stop-gate-failures', next);
      // The threshold-crossing failure returns breakerOpen, so only failures
      // before the threshold become timeout feedback submissions.
      if (next < 3) sink.emit({ verb: 'degradation-notify', target: 'unjustifiedStopGate.timeout' });
    };
    return { tick };
  },
};

/** Correction pressure can mint operator-facing outcomes only until the shared
 * open-artifact cap is full; further reviews hold/coalesce and emit nothing. */
const correctionClassReviewOutcomes: SelfActionController = {
  id: 'correction-class-review-outcomes',
  actionVerb: 'class-review-escalate',
  models: 'src/monitoring/CorrectionClassReview.ts (maxOpenArtifacts + semantic collapse)',
  modelsPath: 'src/monitoring/CorrectionClassReview.ts',
  boundK: 50,
  perTargetBoundK: 1,
  ticks: 200,
  tickMs: 1_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) {
      return correctionClassReviewOutcomes.makeUnderPressure(f, sink);
    },
  },
  makeUnderPressure(f, sink) {
    const durableKey = 'correction-class-review-open-artifacts';
    const seen = new Set<string>((f.durableState.get(durableKey) as string[] | undefined) ?? []);
    return { tick() {
      sink.considered += 1;
      const target = `semantic-class-${sink.considered}`;
      if (seen.size >= 50 || seen.has(target)) return;
      seen.add(target);
      f.durableState.set(durableKey, [...seen]);
      sink.emit({ verb: 'class-review-escalate', target });
    } };
  },
};

/**
 * feedback-execute — the feedback executor's fix attempts (docs/specs/feedback-triage-and-execution.md §4).
 *
 * Convergence argument: under sustained pressure (a fixed backlog of work items, every attempt
 * fails, the job firing every tick) each item gets at most one retry per failure episode
 * (failed → retry → hold execution-failed) and after its second episode the executor no longer
 * takes it automatically (durable per-item episode count in feedback-drain.db). So each item is
 * attempted at most 4 times ever and the total equals 4 × the backlog — horizon-independent.
 * The daily start cap (6) and the concurrency/open-PR caps only pace it further. Items only come
 * back to `work` after new reports or an operator release, which this fixture never supplies.
 */
const feedbackExecute: SelfActionController = {
  id: 'feedback-execute',
  actionVerb: 'spawn-fix-attempt',
  models: 'src/feedback-factory/execute/FeedbackExecutorService.ts (afterFailure episode cap + maxStartsPerDay/maxConcurrent/maxOpenPrs admission)',
  modelsPath: 'src/feedback-factory/execute/FeedbackExecutorService.ts',
  boundK: 20,
  perTargetBoundK: 4,
  ticks: 48 * 7,
  tickMs: 30 * 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return feedbackExecute.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    const DAY_MS = 24 * 60 * 60_000;
    const backlog = Array.from({ length: 5 }, (_, i) => `work-item-${i}`);
    return { tick() {
      sink.considered += 1;
      const day = Math.floor(f.clock.nowMs() / DAY_MS);
      const startsKey = `feedback-execute-starts-${day}`;
      const startsToday = Number(f.durableState.get(startsKey) ?? 0);
      if (startsToday >= 6) return;
      for (const item of backlog) {
        const meta = (f.durableState.get(`feedback-execute-item-${item}`) as { episodes: number; failedSince: number } | undefined) ?? { episodes: 0, failedSince: 0 };
        if (meta.episodes >= 2) continue;
        // Every attempt fails (sustained pressure); two failures end an episode.
        const failedSince = meta.failedSince + 1;
        const next = failedSince >= 2 ? { episodes: meta.episodes + 1, failedSince: 0 } : { episodes: meta.episodes, failedSince };
        f.durableState.set(`feedback-execute-item-${item}`, next);
        f.durableState.set(startsKey, startsToday + 1);
        sink.emit({ verb: 'spawn-fix-attempt', target: item });
        sink.emitTimesMs.push(f.clock.nowMs());
        return;
      }
    } };
  },
};

const feedbackGeneratedDefaultsHeal: SelfActionController = {
  id: 'feedback-factory-generated-defaults-heal',
  actionVerb: 'retry-generated-defaults-repair',
  models: 'src/feedback-factory/drain/FeedbackFactoryDefaultsSelfHeal.ts (SelfHealGate durable episode attempt cap)',
  modelsPath: 'src/feedback-factory/drain/FeedbackFactoryDefaultsSelfHeal.ts',
  boundK: 3,
  perTargetBoundK: 3,
  ticks: 20,
  tickMs: 30_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return feedbackGeneratedDefaultsHeal.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    return { tick() {
      sink.considered += 1;
      const attempts = Number(f.durableState.get('feedback-defaults-heal-attempts') ?? 0);
      if (attempts >= 3) return;
      f.durableState.set('feedback-defaults-heal-attempts', attempts + 1);
      sink.emit({ verb: 'retry-generated-defaults-repair', target: 'generated-defaults' });
    } };
  },
};

/**
 * feedback-triage-tick — the triage tick's model calls and re-queues
 * (docs/specs/feedback-triage-and-execution.md §1 floors 9–10, "Spend").
 *
 * Convergence argument: under sustained pressure (new reports land on the same
 * cluster every tick, quota readable, authority usable) an item is re-queued and
 * re-triaged at most once per 24 h (floor 10's durable last_requeued_at), and
 * every call is reserved against the authority's durable maxCallsPerDay row
 * (re-triage sub-cap 50, second-opinion sub-cap 30). Re-triaging an item that
 * keeps receiving genuinely new evidence is legitimately eternal, so this is a
 * declared Eternal Sentinel floored at one call per item per 24 h; the daily
 * call cap is the delegated give-up. The throttle stamp is durable (in
 * feedback-drain.db), so reconstruction cannot buy a fresh re-queue.
 */
const feedbackTriageTick: SelfActionController = {
  id: 'feedback-triage-tick',
  actionVerb: 'retry-triage-call',
  models: 'src/feedback-factory/triage/FeedbackTriageService.ts (24 h re-queue throttle + authority_daily_usage maxCallsPerDay and sub-caps)',
  modelsPath: 'src/feedback-factory/triage/FeedbackTriageService.ts',
  delegatedGiveUp: 'the durable 24 h per-item re-queue throttle and the authority_daily_usage maxCallsPerDay cap (re-triage sub-cap 50, second-opinion sub-cap 30)',
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 96 * 3,
  tickMs: 15 * 60_000,
  eternalSentinel: { reason: 'an item that keeps receiving new reports is re-triaged at most once per 24 h; total calls are capped per day', rateFloorMs: 24 * 60 * 60_000 },
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return feedbackTriageTick.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    const THROTTLE_MS = 24 * 60 * 60_000;
    return { tick() {
      sink.considered += 1;
      // New reports arrived on the same cluster this tick (the pressure never clears).
      const last = f.durableState.get('feedback-triage-last-requeued-at') as number | undefined;
      if (last !== undefined && f.clock.nowMs() - last < THROTTLE_MS) return;
      f.durableState.set('feedback-triage-last-requeued-at', f.clock.nowMs());
      sink.emit({ verb: 'retry-triage-call', target: 'hot-cluster' });
      sink.emitTimesMs.push(f.clock.nowMs());
    } };
  },
};

/**
 * queue-pace-extra-run — the queue-pace tuner's extra feedback-triage ticks (docs/specs/queue-pace.md §3).
 *
 * Convergence argument: under sustained pressure (the triage queue keeps falling behind with a
 * worker bottleneck forever, every gate passes) the tuner adds at most one extra tick per
 * minGapMinutes (10, floor 10) and at most maxExtraRunsPerDay (12, ceiling 12) per local day,
 * counted in a durable state file reserved BEFORE each call; missing state fails closed (the day's
 * budget treated as spent). Keeping a backlog moving is legitimately eternal, so this is a
 * declared Eternal Sentinel floored at one extra tick per 10 minutes; the daily counter is the
 * delegated give-up. Each extra tick still passes the triage service's own single flight, rate
 * limit, quota pause and daily call cap.
 */
const queuePaceExtraRun: SelfActionController = {
  id: 'queue-pace-extra-run',
  actionVerb: 'nudge-triage-extra-tick',
  models: 'src/monitoring/QueuePaceTuner.ts (minGapMinutes + durable maxExtraRunsPerDay reservation + 6 h cooldown + fail-closed state)',
  modelsPath: 'src/monitoring/QueuePaceTuner.ts',
  delegatedGiveUp: 'the durable per-local-day maxExtraRunsPerDay counter (12) reserved before every extra tick, plus the 10-minute minimum gap',
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 60 * 24 * 2,
  tickMs: 60_000,
  eternalSentinel: { reason: 'a backlog that keeps growing is sped up at most once per 10 minutes and 12 times per day', rateFloorMs: 10 * 60_000 },
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return queuePaceExtraRun.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    const GAP_MS = 10 * 60_000;
    const DAY_MS = 24 * 60 * 60_000;
    return { tick() {
      sink.considered += 1;
      const now = f.clock.nowMs();
      const day = Math.floor(now / DAY_MS);
      const count = Number(f.durableState.get(`queue-pace-extra-${day}`) ?? 0);
      const next = Number(f.durableState.get('queue-pace-next-eligible') ?? 0);
      if (count >= 12 || now < next) return;
      // Durable reservation first, then the request (a crash after this counts it spent).
      f.durableState.set(`queue-pace-extra-${day}`, count + 1);
      f.durableState.set('queue-pace-next-eligible', now + GAP_MS);
      sink.emit({ verb: 'nudge-triage-extra-tick', target: 'feedback.triage' });
      sink.emitTimesMs.push(now);
    } };
  },
};

/**
 * A script anomaly episode may request an investigation more than once as
 * observers retry, but its durable spawned outcome is terminal. New job runs
 * are new external work and separately face the per-slug and machine daily
 * caps in JobResultTriage; this fixture pins one unchanging episode forever.
 */
const jobScriptTriageEpisode: SelfActionController = {
  id: 'job-script-triage-episode',
  actionVerb: 'spawn-triage-session',
  models: 'src/scheduler/JobResultTriage.ts (admitTriageSpawn episode outcome and daily session caps)',
  modelsPath: 'src/scheduler/JobResultTriage.ts',
  boundK: 1,
  perTargetBoundK: 1,
  ticks: 96,
  tickMs: 5 * 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return jobScriptTriageEpisode.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    return { tick() {
      sink.considered += 1;
      if (f.durableState.get('job-script-triage-episode-spawned')) return;
      f.durableState.set('job-script-triage-episode-spawned', true);
      sink.emit({ verb: 'spawn-triage-session', target: 'persistent-anomaly-episode' });
    } };
  },
};

/** The outage backup pass is eligible only after its durable six-hour stamp. */
const jobScriptTriageBackup: SelfActionController = {
  id: 'job-script-triage-backup',
  actionVerb: 'retry-outage-triage',
  models: 'src/scheduler/JobTriageBackupCheck.ts (lastPassAt interval and Jev outage gate)',
  modelsPath: 'src/scheduler/JobTriageBackupCheck.ts',
  delegatedGiveUp: 'durable six-hour lastPassAt and bounded twelve-result sample per slug; investigation sessions retain daily caps',
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 24 * 3,
  tickMs: 60 * 60_000,
  eternalSentinel: { reason: 'one bounded outage pass per six hours while Jev remains unavailable', rateFloorMs: 6 * 60 * 60_000 },
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return jobScriptTriageBackup.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    return { tick() {
      sink.considered += 1;
      const now = f.clock.nowMs();
      const last = f.durableState.get('job-script-triage-backup-last-pass') as number | undefined;
      if (last !== undefined && now - last < 6 * 60 * 60_000) return;
      f.durableState.set('job-script-triage-backup-last-pass', now);
      sink.emit({ verb: 'retry-outage-triage', target: 'outage-sample' });
      sink.emitTimesMs.push(now);
    } };
  },
};

/**
 * feedback-triage-action-list — the operator action list (§5).
 *
 * Convergence argument: each item carries a durable notifiedAt stamp written
 * only after delivery and never re-sent, a day gate (action_list:last_day) caps
 * delivery at one message per day, and a message carries at most 10 items. Under
 * sustained pressure (a fixed backlog of 12 serious holds, the job firing every
 * tick) the total notifications equal the backlog size — horizon-independent —
 * and no item is ever notified twice.
 */
const feedbackTriageActionList: SelfActionController = {
  id: 'feedback-triage-action-list',
  actionVerb: 'notify-action-list',
  models: 'src/feedback-factory/triage/FeedbackTriageService.ts (sendActionList: notifiedAt once-only, once per day, ≤10 items, 23:00–07:30 quiet window)',
  modelsPath: 'src/feedback-factory/triage/FeedbackTriageService.ts',
  boundK: 12,
  perTargetBoundK: 1,
  ticks: 96 * 3,
  tickMs: 15 * 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return feedbackTriageActionList.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    const DAY_MS = 24 * 60 * 60_000;
    const backlog = Array.from({ length: 12 }, (_, i) => `needs-review-hold-${i}`);
    return { tick() {
      sink.considered += 1;
      const day = Math.floor(f.clock.nowMs() / DAY_MS);
      if (f.durableState.get('feedback-action-list-last-day') === day) return;
      const notified = (f.durableState.get('feedback-action-list-notified') as string[] | undefined) ?? [];
      const pending = backlog.filter((item) => !notified.includes(item)).slice(0, 10);
      if (pending.length === 0) return;
      for (const item of pending) sink.emit({ verb: 'notify-action-list', target: item });
      f.durableState.set('feedback-action-list-notified', [...notified, ...pending]);
      f.durableState.set('feedback-action-list-last-day', day);
    } };
  },
};

/**
 * feedback-triage-self-heal-probe — the triage authority re-probe ladder (§6).
 *
 * Convergence argument: under a permanently failing authority, an episode
 * probes at most three times (30 min, 1 h, 4 h; max wall clock 5.5 h), then
 * settles to `exhausted` for that authority generation and raises one Attention
 * item; nothing probes again until a fresh operator approval mints a new
 * generation. Three episodes in seven days escalate at once as flapping. The
 * episode state is durable (triage_meta), so a restart resumes the ladder
 * instead of restarting it.
 */
const feedbackTriageSelfHealProbe: SelfActionController = {
  id: 'feedback-triage-self-heal-probe',
  actionVerb: 'retry-authority-probe',
  models: 'src/feedback-factory/triage/FeedbackTriageService.ts (probe(): 3-attempt ladder per authority generation, then exhausted + one Attention item; 3 episodes / 7 days = flapping)',
  modelsPath: 'src/feedback-factory/triage/FeedbackTriageService.ts',
  boundK: 3,
  perTargetBoundK: 3,
  ticks: 4 * 24,
  tickMs: 15 * 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return feedbackTriageSelfHealProbe.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    const LADDER_MS = [30 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
    return { tick() {
      sink.considered += 1;
      // The authority never answers usably; the episode started at time 0.
      const state = (f.durableState.get('feedback-triage-self-heal') as { attempts: number; nextProbeAt: number; exhausted: boolean } | undefined)
        ?? { attempts: 0, nextProbeAt: LADDER_MS[0], exhausted: false };
      if (state.exhausted || f.clock.nowMs() < state.nextProbeAt) { f.durableState.set('feedback-triage-self-heal', state); return; }
      sink.emit({ verb: 'retry-authority-probe', target: 'triage-authority' });
      const attempts = state.attempts + 1;
      f.durableState.set('feedback-triage-self-heal', attempts >= LADDER_MS.length
        ? { attempts, nextProbeAt: 0, exhausted: true }
        : { attempts, nextProbeAt: f.clock.nowMs() + LADDER_MS[attempts], exhausted: false });
    } };
  },
};

/**
 * Mutual SSH repair is a declared eternal health controller: a persistent path
 * outage must continue to be rechecked, but each repair episode is bounded to
 * four probes / two minutes and three failed episodes open a fifteen-minute
 * per-pair breaker. This model covers the post-breaker steady state: sustained
 * rejection cannot accelerate beyond one constant-cost repair episode per
 * breaker window. Process reconstruction re-enters through the same runtime
 * scheduler and capacity/concurrency brakes; it cannot create an unbounded
 * in-process burst.
 */
const mutualSshRepairSweep: SelfActionController = {
  id: 'mutual-ssh-repair-sweep',
  actionVerb: 'repair-retry',
  models: 'src/core/MutualSshHealthController.ts (four-attempt episode + three-episode, fifteen-minute pair breaker)',
  modelsPath: 'src/core/MutualSshHealthController.ts',
  delegatedGiveUp: 'the per-pair three-episode breaker and fifteen-minute breaker window',
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 24,
  tickMs: 5 * 60_000,
  eternalSentinel: { reason: 'bounded transport-health repair with a hard post-breaker rate floor', rateFloorMs: 15 * 60_000 },
  restartPosture: {
    pressureSurvives: false,
    resetSafeReason: 'A process restart starts one new bounded repair episode; the runtime sweep lock, concurrency four ceiling, four-attempt cap, and two-minute deadline still bound that episode.',
  },
  makeUnderPressure(f, sink) {
    const RATE_FLOOR_MS = 15 * 60_000;
    let nextAllowedAtMs = 0;
    return { tick() {
      sink.considered += 1;
      if (f.clock.nowMs() < nextAllowedAtMs) return;
      sink.emit({ verb: 'repair-retry', target: 'unreachable-peer-direction' });
      sink.emitTimesMs.push(f.clock.nowMs());
      nextAllowedAtMs = f.clock.nowMs() + RATE_FLOOR_MS;
    } };
  },
};

const followMeEnrollmentConsumer: SelfActionController = {
  id: 'follow-me-enrollment-consumer',
  actionVerb: 'redrive-enroll-start',
  models: 'src/server/AgentServer.ts + src/coordination/FollowMeConsumerBackoffStore.ts (four-attempt pair episode, causal-evidence wake)',
  modelsPath: 'src/server/AgentServer.ts',
  delegatedGiveUp: 'the durable fourth-failure parked state for an unchanged account-machine evidence key',
  boundK: 4,
  perTargetBoundK: 4,
  ticks: 24,
  tickMs: 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) {
      return followMeEnrollmentConsumer.makeUnderPressure(f, sink);
    },
  },
  makeUnderPressure(f, sink) {
    return { tick() {
      sink.considered += 1;
      const attempts = Number(f.durableState.get('follow-me-attempts') ?? 0);
      if (attempts >= 4) return;
      f.durableState.set('follow-me-attempts', attempts + 1);
      sink.emit({ verb: 'redrive-enroll-start', target: 'account-machine-pair' });
    } };
  },
};

/**
 * check-in-reminder — the dated-commitment reminder pass (ACT-724).
 *
 * Convergence argument: the emit is guarded by a DURABLE stamp written only on
 * a successful send, so a delivered reminder is never re-emitted; and by a
 * bounded attempt counter, so a permanently failing transport stops at
 * CHECK_IN_MAX_ATTEMPTS instead of retrying forever. Under sustained pressure
 * (every send failing, every pass firing) the total emit count is therefore
 * bounded by attempts, not by elapsed time — the settling brake is the counter.
 *
 * Modeled here at its WORST case: the send always fails, so the stamp never
 * lands and only the attempt bound can stop it. If that bound were missing this
 * model would emit once per tick forever, and the ratchet would fail.
 */
const checkInReminderPass: SelfActionController = {
  id: 'check-in-reminder-pass',
  actionVerb: 'check-in-notify',
  models: 'src/monitoring/CheckInReminderReconciler.ts (send-then-stamp + bounded attempts)',
  modelsPath: 'src/monitoring/CheckInReminderReconciler.ts',
  // The attempt counter is persisted on the commitment through the CAS mutate
  // BEFORE the send, so a restart resumes the count rather than resetting it —
  // a crash-loop cannot buy fresh attempts. The restart model therefore
  // reconstructs from durableState and must still settle.
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) {
      const KEY = 'check-in-attempts';
      return {
        tick() {
          sink.considered += 1;
          const attempts = (f.durableState.get(KEY) as number | undefined) ?? 0;
          if (attempts >= 5) return; // the bound survives the restart
          f.durableState.set(KEY, attempts + 1);
          sink.emit({ verb: 'check-in-notify', target: 'commitment-topic' });
        },
      };
    },
  },
  boundK: 5, // CHECK_IN_MAX_ATTEMPTS
  perTargetBoundK: 5,
  ticks: 20,
  tickMs: 5 * 60_000, // the built-in job cadence
  makeUnderPressure(f, sink) {
    const KEY = 'check-in-attempts';
    return {
      tick() {
        sink.considered += 1;
        const attempts = (f.durableState.get(KEY) as number | undefined) ?? 0;
        // Retries exhausted -> terminal. This is the brake; without it the
        // never-landing stamp would let this emit on every tick forever.
        if (attempts >= 5) return;
        f.durableState.set(KEY, attempts + 1);
        // The worst case: the send FAILS, so no stamp is written and the
        // commitment stays selectable until the attempt bound stops it.
        sink.emit({ verb: 'check-in-notify', target: 'commitment-topic' });
      },
    };
  },
};

/**
 * job-failure-alert-delivery — scheduler-owned escalation while a job remains
 * failed. The first eligible attempt happens immediately. Scheduler-owned
 * timers then wake the durable 5m → 15m → 1h capped backoff, so permanent
 * transport failure remains visible without depending on another job run and
 * without becoming a per-run flood. Successful but unresolved delivery follows
 * an even wider reminder cadence in the real controller; the permanently
 * failing transport is the higher-frequency adversary and therefore pins the
 * convergence floor here.
 */
const jobFailureAlertDelivery: SelfActionController = {
  id: 'job-failure-alert-delivery',
  actionVerb: 'job-alert-notify',
  models: 'src/scheduler/JobScheduler.ts (persistent timer-owned failure-alert retry and reminder cadence)',
  modelsPath: 'src/scheduler/JobScheduler.ts',
  delegatedGiveUp: 'the durable 5-minute minimum retry floor widening to a one-hour cap while the alert remains undelivered',
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 48,
  tickMs: 5 * 60_000,
  eternalSentinel: {
    reason: 'An unresolved critical job failure must remain capable of reaching its operator; delivery attempts are constant-cost and rate-floored rather than abandoned.',
    rateFloorMs: 5 * 60_000,
  },
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) {
      return jobFailureAlertDelivery.makeUnderPressure(f, sink);
    },
  },
  makeUnderPressure(f, sink) {
    const RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
    const ATTEMPTS_KEY = 'job-failure-alert-attempts';
    const NEXT_KEY = 'job-failure-alert-next-eligible-at';
    return {
      tick() {
        sink.considered += 1;
        const nextEligibleAt = Number(f.durableState.get(NEXT_KEY) ?? 0);
        if (f.clock.nowMs() < nextEligibleAt) return;

        sink.emit({ verb: 'job-alert-notify', target: 'failed-job' });
        sink.emitTimesMs.push(f.clock.nowMs());

        // Pinned pressure: delivery fails forever. Persist the widening retry
        // state before the next tick, exactly as the real controller does.
        const attempts = Number(f.durableState.get(ATTEMPTS_KEY) ?? 0) + 1;
        f.durableState.set(ATTEMPTS_KEY, attempts);
        const delay = RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)];
        f.durableState.set(NEXT_KEY, f.clock.nowMs() + delay);
      },
    };
  },
};

/**
 * undated-action-resurfacer — bounded Attention reach for action rows that the
 * due-date checker cannot see. The backlog can remain non-empty indefinitely,
 * so this is an Eternal Sentinel rather than a controller that truthfully
 * settles to zero. Its durable run ledger enforces a hard four-hour rate floor
 * across process reconstruction; each row additionally cools down for 14 days
 * and exits the loop after three unchanged raises. On a multi-machine agent the
 * pool-agreed stable ledger owner must also hold the serving lease, so a handoff
 * or divergent local owner config cannot reset either brake by constructing fresh
 * local state.
 */
const undatedActionResurfacer: SelfActionController = {
  id: 'undated-action-resurfacer',
  actionVerb: 'undated-action-notify',
  models: 'src/monitoring/UndatedActionResurfacer.ts (pool-agreed stable owner + serving lease + durable global cadence + per-row cooldown + three-raise disposition terminal)',
  modelsPath: 'src/monitoring/UndatedActionResurfacer.ts',
  delegatedGiveUp: 'the pool-agreed stable-owner ledger and serving-lease conjunction, durable three-raise needs-disposition terminal for each unchanged action, and four-hour global cadence floor',
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: 3,
  ticks: 48,
  tickMs: 60 * 60_000,
  eternalSentinel: {
    reason: 'An undated high-priority backlog can remain non-empty indefinitely; oldest-row reach must continue at a fixed, non-accumulating cadence.',
    rateFloorMs: 4 * 60 * 60_000,
  },
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) {
      return undatedActionResurfacer.makeUnderPressure(f, sink);
    },
  },
  makeUnderPressure(f, sink) {
    const KEY = 'undated-action-last-run-at';
    const RATE_FLOOR_MS = 4 * 60 * 60_000;
    return {
      tick() {
        sink.considered += 1;
        const lastRunAt = f.durableState.get(KEY) as number | undefined;
        if (lastRunAt !== undefined && f.clock.nowMs() - lastRunAt < RATE_FLOOR_MS) return;
        f.durableState.set(KEY, f.clock.nowMs());
        sink.emitTimesMs.push(f.clock.nowMs());
        sink.emit({ verb: 'undated-action-notify', target: `oldest-eligible-${sink.count}` });
      },
    };
  },
};

/**
 * standdown-maintenance — the duplicate-session stand-down's NOTIFY-class
 * emissions (docs/specs/duplicate-session-standdown.md; SessionReaper.#standDownTick
 * + StandDownRegistry) under the pathological pressure: a topic whose duplicate
 * REAPPEARS immediately after every clean retirement, a model that retries its
 * blocked calls forever, and a user actively messaging the muzzled copy.
 *
 * Why this SETTLES (horizon-independent, not merely paced):
 *  - every attention item carries a STABLE id per (topic, kind) —
 *    standdown-churn:T, standdown-latched:T, standdown-expired:T:S,
 *    standdown-mutual-muzzle:T, standdown-health — and the attention store
 *    dedupes on id, so sustained pressure yields at most ONE of each;
 *  - the per-episode tmux/user notices key on the EPISODE, and a new episode
 *    after any release/expire requires a STRICTLY NEWER ownership epoch (the
 *    admission latch). Under fixed pressure the epoch never advances, so after
 *    the first release→latch no further episode can mint and the notice count
 *    freezes;
 *  - the clean-close flap cycle (spawn→register→drain→close) deliberately emits
 *    NO notify action at all (normal-path silence) — its visibility is the
 *    deduped churn item, not a stream.
 */
const standDownMaintenance: SelfActionController = {
  id: 'standdown-maintenance',
  actionVerb: 'standdown-notify',
  models: 'src/monitoring/SessionReaper.ts (#standDownTick — deduped per-(topic,kind) attention ids; per-episode notice budgets with epoch-gated re-admission; silent clean-close cycles)',
  modelsPath: 'src/monitoring/SessionReaper.ts',
  restartPosture: {
    pressureSurvives: true,
    // Entries, episode latches, notice budgets and the churn window all live in
    // the durable StandDownRegistry file; a restart reloads them, so a bounce
    // cannot re-mint a notice, reset the latch, or re-raise a deduped item.
    restartUnderPressure(f, sink) {
      return makeStandDownPressureLoop(f.durableState, sink);
    },
  },
  // The full deduped set for one flapping topic: 1 per-episode user notice
  // (first episode, before the latch) + churn + latched + expired + health.
  boundK: 5,
  perTargetBoundK: 1, // each emission lands on its own stable dedup id
  ticks: 120,
  tickMs: 60_000,
  makeUnderPressure(f, sink) {
    // The REAL registry is durable from the first write, so the fresh arm
    // writes the same durable state the restart arm reads — with a private map
    // here, pre-restart emissions would be forgotten and re-raised, which is
    // exactly the bounce-re-mints-a-notice defect the durable file prevents.
    return makeStandDownPressureLoop(f.durableState, sink);
  },
};

/** One loop body shared by the fresh and restart-surviving harness arms, so the
 *  restart model cannot drift from the fresh one (the state map IS the durable
 *  registry file in miniature). */
function makeStandDownPressureLoop(d: Map<string, unknown>, sink: ActionSink): { tick(): void } {
  const CYCLE_TICKS = 4;      // dwell(2) + corroborated drain(2)
  const CHURN_THRESHOLD = 3;  // closedEpisodeChurnThreshold default
  if (!d.has('sd:tick')) d.set('sd:tick', 0);
  if (!d.has('sd:closed')) d.set('sd:closed', 0);
  if (!d.has('sd:raised')) d.set('sd:raised', new Set<string>());
  if (!d.has('sd:latched')) d.set('sd:latched', false);
  const raiseOnce = (id: string) => {
    const raised = d.get('sd:raised') as Set<string>;
    if (raised.has(id)) return; // the attention store dedupes on the item id
    raised.add(id);
    sink.emit({ verb: 'standdown-notify', target: id });
  };
  return {
    tick() {
      sink.considered += 1;
      const tickN = (d.get('sd:tick') as number) + 1;
      d.set('sd:tick', tickN);
      if (d.get('sd:latched') as boolean) {
        // The admission latch holds: the producer's unchanged verdict (same
        // ownership epoch) cannot re-mint the episode. The latch-blocked
        // attempts keep climbing and raise their ONE deduped item.
        raiseOnce('attention:standdown-latched');
        return;
      }
      if (tickN % CYCLE_TICKS !== 0) return;
      const closed = (d.get('sd:closed') as number) + 1;
      d.set('sd:closed', closed);
      // Clean-close cycles are SILENT (normal-path silence); their visibility is
      // the deduped churn item once the threshold crosses.
      if (closed > CHURN_THRESHOLD) raiseOnce('attention:standdown-churn');
      // Then the user messages the muzzled copy: divert is unwired → immediate
      // release → the episode LATCHES (armLatch: true on an adjudicated
      // release) — one per-episode user notice went out first.
      if (closed === CHURN_THRESHOLD + 2) {
        raiseOnce('notice:session-episode-1');
        d.set('sd:latched', true);
      }
    },
  };
}

/**
 * subscription-relogin-redrive — models the repair service under a provider
 * that rejects forever. Attempt count, wall-clock start and the slow-retry
 * count are durable episode fields, so restart cannot refill any budget. Each
 * run spends at most 3 attempts and settles `failed`; while the incident stays
 * open a slow automatic retry (6 h, then 24 h apart) starts a fresh run, at most
 * 3 times per incident (spec relogin-unattended-agent-session-and-slow-retry).
 * So the total is 3 × (1 + 3) = 12 drives per incident, horizon-independent;
 * after that the same failed episode emits nothing.
 */
const subscriptionReloginRedrive: SelfActionController = {
  id: 'subscription-relogin-redrive',
  actionVerb: 'relogin-redrive',
  models: 'src/core/SubscriptionReloginService.ts + SubscriptionReloginOrchestrator.ts (durable maxAttempts/maxWallMs, durable slowRetryCount ≤ 3 with 6 h/24 h delays, terminal breaker)',
  modelsPath: 'src/core/SubscriptionReloginService.ts',
  boundK: 12,
  perTargetBoundK: 12,
  ticks: 200,
  tickMs: 60 * 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeSubscriptionReloginPressureLoop(f, sink),
  },
  makeUnderPressure(f, sink) {
    return makeSubscriptionReloginPressureLoop(f, sink);
  },
};

function makeSubscriptionReloginPressureLoop(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const ATTEMPTS = 3;
  const MAX_SLOW_RETRIES = 3;
  const DELAYS_MS = [6 * 60 * 60_000, 24 * 60 * 60_000];
  const attemptsKey = 'subscription-relogin:attempts';
  const retriesKey = 'subscription-relogin:slow-retries';
  const failedAtKey = 'subscription-relogin:failed-at';
  if (!f.durableState.has(attemptsKey)) f.durableState.set(attemptsKey, 0);
  if (!f.durableState.has(retriesKey)) f.durableState.set(retriesKey, 0);
  return {
    tick() {
      sink.considered += 1;
      const attempts = f.durableState.get(attemptsKey) as number;
      if (attempts < ATTEMPTS) {
        sink.emit({ verb: 'relogin-redrive', target: 'account-machine-cell' });
        f.durableState.set(attemptsKey, attempts + 1);
        if (attempts + 1 >= ATTEMPTS) f.durableState.set(failedAtKey, f.clock.nowMs()); // settles `failed`
        return;
      }
      // Failed. A slow retry starts a fresh run only once due and only while the durable cap allows.
      const retries = f.durableState.get(retriesKey) as number;
      if (retries >= MAX_SLOW_RETRIES || !f.targetAlwaysRejects()) return;
      const failedAt = f.durableState.get(failedAtKey) as number;
      if (f.clock.nowMs() < failedAt + DELAYS_MS[Math.min(retries, DELAYS_MS.length - 1)]) return;
      f.durableState.set(retriesKey, retries + 1);
      f.durableState.set(attemptsKey, 0);
    },
  };
}

/**
 * window-lifecycle-issue-escalation — the WindowLifecycleObligationLedger's
 * owned 60-second controller tick. It persists each novel issue in
 * `ledger.surfacedIssues` BEFORE dispatch, so periodic and mutation-route ticks
 * share one durable brake; a fixed unresolved issue emits once across reconstruction.
 */
const windowLifecycleIssueEscalation: SelfActionController = {
  id: 'window-lifecycle-issue-escalation',
  actionVerb: 'window-lifecycle-notify',
  models: 'src/server/routes.ts (WindowLifecycleObligationLedger owned tick — surfacedIssues dedupe-before-send brake)',
  modelsPath: 'src/server/routes.ts',
  boundK: 1,
  perTargetBoundK: 1,
  ticks: 20,
  tickMs: 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeWindowLifecycleIssueEscalation(f, sink),
  },
  makeUnderPressure: (f, sink) => makeWindowLifecycleIssueEscalation(f, sink),
};

/** W32 cadence delivery under permanently failing session/Telegram paths.
 * Checkpoint, report, and failure-notice intents are persisted before their
 * boundary calls; their independent 2/3/3 brakes survive restart. */
const windowRunCadenceDeliveryRedrive: SelfActionController = {
  id: 'window-run-cadence-delivery-redrive',
  actionVerb: 'retry-cadence-delivery',
  models: 'src/core/WindowRunCadenceExecutor.ts (durable checkpoint/report/notification counters + exponential backoff + 2/3/3 brakes)',
  modelsPath: 'src/core/WindowRunCadenceExecutor.ts',
  boundK: 8,
  perTargetBoundK: 3,
  ticks: 20,
  tickMs: 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeWindowRunCadenceDeliveryRedrive(f, sink),
  },
  makeUnderPressure: (f, sink) => makeWindowRunCadenceDeliveryRedrive(f, sink),
};

function makeWindowRunCadenceDeliveryRedrive(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const targets = [
    { target: 'checkpoint-1', max: 2 },
    { target: 'report-1', max: 3 },
    { target: 'failure-notice-1', max: 3 },
  ] as const;
  return {
    tick() {
      sink.considered += 1;
      const due = targets.find(item => ((f.durableState.get(`window-run-cadence:${item.target}`) as number | undefined) ?? 0) < item.max);
      if (!due) return;
      const key = `window-run-cadence:${due.target}`;
      const attempts = (f.durableState.get(key) as number | undefined) ?? 0;
      sink.emit({ verb: 'retry-cadence-delivery', target: due.target });
      f.durableState.set(key, attempts + 1);
    },
  };
}

function makeWindowLifecycleIssueEscalation(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const DURABLE_KEY = 'window-lifecycle:surfaced-issues';
  const ISSUE = 'cadence.report.3h@window:predicate-unsatisfied';
  return {
    tick() {
      sink.considered += 1;
      const surfaced = (f.durableState.get(DURABLE_KEY) as string[] | undefined) ?? [];
      if (surfaced.includes(ISSUE)) return;
      // Production saves before the async send, so failure or reconstruction
      // cannot turn the same issue into an emit loop.
      f.durableState.set(DURABLE_KEY, [...surfaced, ISSUE]);
      sink.emit({ verb: 'window-lifecycle-notify', target: ISSUE });
    },
  };
}

/** Machine identity recovery claimant under permanent peer rejection. The
 * durable per-keyEpoch episode caps at three and survives restart; the runtime
 * governor further paces each peer to one attempt per 24 hours. */
const identityReannounce: SelfActionController = {
  id: 'identity-reannounce',
  actionVerb: 'retry-identity-reannounce',
  models: 'src/commands/server.ts (IdentityReannounceService claimant trigger + durable three-attempt episode cap)',
  modelsPath: 'src/commands/server.ts',
  boundK: 3,
  perTargetBoundK: 3,
  ticks: 100,
  tickMs: 60 * 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeIdentityReannouncePressureLoop(f, sink),
  },
  makeUnderPressure: (f, sink) => makeIdentityReannouncePressureLoop(f, sink),
};

function makeIdentityReannouncePressureLoop(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const countKey = 'identity-reannounce:epoch:attempts';
  const lastKey = 'identity-reannounce:last-at';
  return {
    tick() {
      sink.considered += 1;
      const attempts = (f.durableState.get(countKey) as number | undefined) ?? 0;
      const lastAt = (f.durableState.get(lastKey) as number | undefined) ?? Number.NEGATIVE_INFINITY;
      if (attempts >= 3 || f.clock.nowMs() - lastAt < 24 * 60 * 60_000) return;
      sink.emit({ verb: 'retry-identity-reannounce', target: 'destination-peer' });
      f.durableState.set(countKey, attempts + 1);
      f.durableState.set(lastKey, f.clock.nowMs());
    },
  };
}

const telegramBrowserCanaryRecovery: SelfActionController = {
  id: 'telegram-browser-canary-recovery', actionVerb: 'retry-browser-canary',
  models: 'OriginBrowserRecovery persists a 15-minute activation floor and FailureEpisodeLatch; OriginBrowserExecutor retains the original nine-attempt outbox budget.',
  modelsPath: 'src/messaging/telegram-origin/OriginBrowserRecovery.ts',
  boundK: 9, perTargetBoundK: 9, ticks: 400, tickMs: 30_000,
  restartPosture: { pressureSurvives: true, restartUnderPressure: makeTelegramBrowserCanaryPressure },
  makeUnderPressure: makeTelegramBrowserCanaryPressure,
};
function makeTelegramBrowserCanaryPressure(f: PressureFixture, sink: ActionSink): { tick(): void } {
  return { tick() {
    sink.considered++;
    const attempts = (f.durableState.get('telegram-canary:attempts') as number | undefined) ?? 0;
    if (!f.targetAlwaysRejects() || attempts >= 9) return;
    const fence = `attempt-${attempts}`;
    const prior = f.durableState.get('telegram-canary:state') as BrowserRecoveryState | undefined;
    const start = advanceBrowserRecovery(prior ?? null, { kind: 'begin', fence }, f.clock.nowMs());
    if (!start.allowed) return;
    let state = advanceBrowserRecovery(start.state, { kind: 'failure', fence, buildId: 'unsupported', final: false }, f.clock.nowMs()).state;
    sink.emit({ verb: 'retry-browser-canary', target: 'managed-profile' });
    state = advanceBrowserRecovery(state, { kind: 'failure', fence, buildId: 'unsupported', final: true }, f.clock.nowMs()).state;
    f.durableState.set('telegram-canary:state', state);
    f.durableState.set('telegram-canary:attempts', attempts + 1);
  } };
}

/**
 * origin-store-worker-restart — OriginStore replaces a failed worker generation
 * (startup failure, crash, or a request stuck past the stall deadline) after an
 * exponential backoff (1s doubling to 30s). The budget is consecutive failures,
 * restored ONLY after a generation stays failure-free for a 5-minute healthy
 * window (one served response between recurring stalls restores nothing);
 * past the cap (6) the store stays down.
 * The runtime's pre-existing 15-minute recovery reopen builds a replacement via
 * openReplacement(), which inherits the spent count and outage episode, so a
 * sustained outage never earns a fresh burst. Reconstruction here = that
 * replacement (durable count carried). A process restart does reset the count;
 * process restarts are the lifeline's own bounded controller.
 */
const originStoreWorkerRestart: SelfActionController = {
  id: 'origin-store-worker-restart', actionVerb: 'restart-origin-store-worker',
  models: 'OriginStore.fail(): bounded exponential-backoff restart of the origin worker, cap 6 consecutive failures, budget restored only after a 5-minute failure-free healthy window; openReplacement() carries the count across the runtime recovery reopen.',
  modelsPath: 'src/messaging/telegram-origin/OriginStore.ts',
  boundK: 6, perTargetBoundK: 6, ticks: 600, tickMs: 1_000,
  restartPosture: { pressureSurvives: true, restartUnderPressure: makeOriginStoreRestartPressure },
  makeUnderPressure: makeOriginStoreRestartPressure,
};
function makeOriginStoreRestartPressure(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const failuresKey = 'origin-store:consecutive-failures', nextKey = 'origin-store:next-restart-at';
  const backoff = (failures: number) => Math.min(1_000 * 2 ** (failures - 1), 30_000);
  // The first generation has already failed when pressure begins.
  if (!f.durableState.has(failuresKey)) {
    f.durableState.set(failuresKey, 1);
    f.durableState.set(nextKey, f.clock.nowMs() + backoff(1));
  }
  return { tick() {
    sink.considered++;
    if (!f.targetAlwaysRejects()) return;
    const failures = f.durableState.get(failuresKey) as number;
    if (failures > 6) return; // exhausted: only a failure-free healthy window restores the budget
    if (f.clock.nowMs() < (f.durableState.get(nextKey) as number)) return;
    sink.emit({ verb: 'restart-origin-store-worker', target: 'origin-store-worker' });
    // Under sustained pressure the new generation fails as well.
    f.durableState.set(failuresKey, failures + 1);
    f.durableState.set(nextKey, f.clock.nowMs() + backoff(failures + 1));
  } };
}

/** These entries count automatic diagnostic CYCLES, not their nested attempts.
 * One owned cycle has at most two sequential worker attempts; one native cycle
 * has at most one adapter invocation. The modeled zero-duration completion is
 * the fastest possible recurring schedule within a surviving instance.
 * Actual single-flight, cancellation and cleanup latches are separately tested
 * against the production classes in telegram-origin-canary-scheduling.test.ts.
 * This rate model does not prove those behaviors or native/provider execution.
 * Each reconstruction waits 60s before starting automatic work. No durable
 * count is needed: closing/restarting can only postpone the next automatic run.
 * Explicit one-shot run() calls are outside this automatic-controller model.
 */
const telegramOriginOwnedDetectorCanary: SelfActionController = {
  id: 'telegram-origin-owned-detector-canary', actionVerb: 'retry-owned-detector-canary-cycle',
  models: 'OriginDetectorCanary automatic start cycle: <=2 sequential workers/run, 6s contract checks then 30s cleanup proof per attempt, ownership retained until termination and fixture removal settle, cleanup-failure latch, 60s startup wait on every boot and >=60s completion-relative recurrence.',
  modelsPath: 'src/messaging/telegram-origin/OriginDetectorCanary.ts',
  delegatedGiveUp: 'The instance closes or latches on unverified cleanup; each run has at most two timed worker attempts. Successful cleanup permits the next completion-relative cycle; restart resets this local state.',
  boundK: Number.POSITIVE_INFINITY, perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 240, tickMs: 1_000,
  eternalSentinel: { reason: 'Fixed owned-fixture diagnostic work, without transport authority; every boot waits 60s before its first automatic cycle, then recurrence waits at least 60s after completion.', rateFloorMs: 60_000 },
  restartPosture: { pressureSurvives: true, restartUnderPressure: makeOriginCanaryCyclePressure },
  makeUnderPressure: makeOriginCanaryCyclePressure,
};
const telegramOriginNativeModelCanary: SelfActionController = {
  id: 'telegram-origin-native-model-canary', actionVerb: 'retry-native-model-canary-cycle',
  models: 'OriginNativeCanaryLane automatic start cycle: <=1 isolated adapter/run, cleanup-failure latch, 60s startup wait on every boot and >=60s completion-relative recurrence.',
  modelsPath: 'src/messaging/telegram-origin/OriginNativeCanaryLane.ts',
  delegatedGiveUp: 'Close cancels the adapter and retains its slot until cleanup; cleanup failure latches this instance. One adapter invocation/run with a 30s cancellation deadline; restart resets local state.',
  boundK: Number.POSITIVE_INFINITY, perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 240, tickMs: 1_000,
  eternalSentinel: { reason: 'Fixed two-turn native-format diagnostic with only a loopback fixture provider; a 60s startup wait plus completion-relative recurrence preserves the automatic floor across restarts; no real provider execution is certified.', rateFloorMs: 60_000 },
  restartPosture: { pressureSurvives: true, restartUnderPressure: makeOriginCanaryCyclePressure },
  makeUnderPressure: makeOriginCanaryCyclePressure,
};
const telegramOriginSourcePoller: SelfActionController = {
  id: 'telegram-origin-source-poller', actionVerb: 'refresh-origin-source-observation',
  models: 'OriginSourcePoller fixed-rate exact-file metadata observation: one overlap-suppressed pass no sooner than every 250ms; close synchronously cancels recurrence and a closed fence suppresses any late callback.',
  modelsPath: 'src/messaging/telegram-origin/OriginSourcePoller.ts',
  delegatedGiveUp: 'The owning reader or observer calls close(), which cancels the sole interval immediately; in-flight stat completion cannot emit after the closed fence.',
  boundK: Number.POSITIVE_INFINITY, perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 40, tickMs: 250,
  eternalSentinel: { reason: 'Constant-size metadata observation over a fixed exact-file set; one overlap-suppressed pass per 250ms floor and no source mutation or transport authority.', rateFloorMs: 250 },
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Reconstruction first captures a baseline and waits a full 250ms interval, so restart cannot create a callback burst.' },
  makeUnderPressure(f, sink) {
    let nextPollAt = f.clock.nowMs() + 250;
    return { tick() {
      sink.considered++;
      if (f.clock.nowMs() < nextPollAt) return;
      sink.emit({ verb: 'refresh-origin-source-observation', target: 'exact-authority-source-set' });
      sink.emitTimesMs.push(f.clock.nowMs());
      nextPollAt = f.clock.nowMs() + 250;
    } };
  },
};
function makeOriginCanaryCyclePressure(f: PressureFixture, sink: ActionSink): { tick(): void } {
  // The production classes schedule this same startup delay on each start().
  let nextCycleAt = f.clock.nowMs() + 60_000;
  return { tick() {
    sink.considered++;
    if (f.clock.nowMs() < nextCycleAt) return;
    sink.emit({ verb: 'retry-diagnostic-cycle', target: 'isolated-diagnostic-fixture' });
    sink.emitTimesMs.push(f.clock.nowMs());
    nextCycleAt = f.clock.nowMs() + 60_000;
  } };
}

/**
 * passkey-revoke-outbox — durable re-delivery of a signed passkey-cell revoke to a peer
 * (agent-held-google-passkey §3.2 / FD15). Under the pinned fixture the peer ALWAYS rejects
 * (unreachable). Convergence argument: attempts follow a fixed backoff (1h, 6h, then daily)
 * clocked from the durable next-attempt time; at 30 days after issue the entry ESCALATES
 * (one aggregated attention item per machine) and automatic re-delivery STOPS, apart from ONE
 * post-breaker attempt when the peer is next observed online (recorded durably, so a flapping
 * peer cannot re-trigger it). So the total emit count over ANY horizon is bounded by
 * 3 + 29 + 1 = 33 per entry — horizon-independent, restart-independent (attempts/next-attempt
 * live in the file). The peer-online forward pull is EDGE-triggered (one pull per offline→online
 * transition, never below a 15-minute floor) — a peer that stays online-but-refusing gets the plain
 * backoff, which is what the fixture below models: the peer is online on every tick and never
 * transitions, so no pull ever fires and the count is the schedule's.
 */
const passkeyRevokeOutbox: SelfActionController = {
  id: 'passkey-revoke-outbox',
  actionVerb: 'retry-deliver-revoke',
  models: 'src/core/PasskeyRevokeOutbox.ts (1h/6h/daily backoff, 30-day breaker + one post-breaker attempt when the peer is next online)',
  modelsPath: 'src/core/PasskeyRevokeOutbox.ts',
  boundK: 33,
  perTargetBoundK: 33,
  ticks: 45,
  tickMs: 24 * 60 * 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return passkeyRevokeOutbox.makeUnderPressure(f, sink); },
  },
  makeUnderPressure(f, sink) {
    const BACKOFF = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
    const BREAKER_MS = 30 * 24 * 60 * 60_000;
    const issuedAt = Number(f.durableState.get('pk-outbox-issued') ?? f.clock.nowMs());
    f.durableState.set('pk-outbox-issued', issuedAt);
    return { tick() {
      sink.considered += 1;
      const now = f.clock.nowMs();
      const state = String(f.durableState.get('pk-outbox-state') ?? 'pending');
      if (state === 'escalated') {
        // The single post-breaker attempt — the fixture's peer is "online" every tick, and it still rejects.
        if (f.durableState.get('pk-outbox-post-breaker') === true) return;
        f.durableState.set('pk-outbox-post-breaker', true);
        sink.emit({ verb: 'retry-deliver-revoke', target: 'peer-machine' });
        sink.emitTimesMs.push(now);
        return;
      }
      if (now - issuedAt >= BREAKER_MS) { f.durableState.set('pk-outbox-state', 'escalated'); return; }
      const nextAt = Number(f.durableState.get('pk-outbox-next') ?? now);
      if (now < nextAt) return;
      const attempts = Number(f.durableState.get('pk-outbox-attempts') ?? 0) + 1;
      f.durableState.set('pk-outbox-attempts', attempts);
      sink.emit({ verb: 'retry-deliver-revoke', target: 'peer-machine' });
      sink.emitTimesMs.push(now);
      if (f.targetAlwaysRejects()) f.durableState.set('pk-outbox-next', now + BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)]);
    } };
  },
};


// ── a2a-single-agent-identity (§1.2 adoption loop, §2.2 coherence detector) ──

/**
 * agent-identity-adoption — the §1.2 adoption loop, a DECLARED Eternal Sentinel
 * (P19): a paired machine with no agent identity observes its siblings every
 * round (constant cost: one signed read per active sibling) and sends at most
 * ONE `agent-identity-request` per 10 min, one in flight, rotating on a typed
 * refusal; it escalates ONCE (4 consecutive fleet refusals or 120 s → one `high`
 * item, re-raised only when the refusal REASON changes) and keeps healing at the
 * 5-min observe floor after 1 h. Under the pinned fixture (every sibling refuses
 * forever — `targetAlwaysRejects`), the emits are the paced requests + the single
 * escalation: never faster than the 10-min floor, never a second item.
 */
function makeAgentIdentityAdoptionLoop(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const REQUEST_INTERVAL_MS = 10 * 60_000;
  const ESCALATE_AFTER_MS = 120_000;
  const ESCALATE_AFTER_REFUSALS = 4;
  // The responder's per-requester share interval is SERVER-side state (durable across
  // the requester's restarts): a restarted requester's first request is refused
  // `rate-limited` with retryAfterMs and the requester paces off it.
  const key = 'agent-identity-adoption:responder-last-share-at';
  const startedAt = f.clock.nowMs();
  let refusals = 0;
  let escalated = false;
  return {
    tick() {
      sink.considered += 1;
      // Observe round (constant per-round cost; not an emit — a signed read).
      const lastShare = (f.durableState.get(key) as number | undefined) ?? Number.NEGATIVE_INFINITY;
      if (f.clock.nowMs() - lastShare < REQUEST_INTERVAL_MS) {
        // Paced (locally, or by the responder's retryAfterMs after a restart).
      } else {
        sink.emit({ verb: 'retry', target: 'sibling-request' });
        sink.emitTimesMs.push(f.clock.nowMs());
        f.durableState.set(key, f.clock.nowMs());
        if (f.targetAlwaysRejects()) refusals += 1;
      }
      const byRefusals = refusals >= ESCALATE_AFTER_REFUSALS;
      const byTime = f.clock.nowMs() - startedAt >= ESCALATE_AFTER_MS;
      if (!escalated && (byRefusals || byTime)) {
        // ONE item per machine; re-raised only when the refusal reason changes (never here).
        escalated = true;
        // Counted in the audit, not as a paced emit: a single constant-cost line.
      }
    },
  };
}

const agentIdentityAdoption: SelfActionController = {
  id: 'agent-identity-adoption',
  actionVerb: 'adoption-retry',
  models: 'src/core/AgentIdentityAdoption.ts (AgentIdentityAdoptionLoop — ≤1 request per 10 min, one in flight, ONE escalation per reason, 5-min observe floor)',
  modelsPath: 'src/core/AgentIdentityAdoption.ts',
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeAgentIdentityAdoptionLoop(f, sink),
  },
  delegatedGiveUp: 'the responder-side share rate-limit (one share per requester per 10 min, carried as retryAfterMs) + the ONE-item escalation after 4 fleet refusals / 120 s — the heal continues at the 5-min floor, never a second item for the same reason',
  boundK: Number.POSITIVE_INFINITY, // exempt — bounded by the 10-min request floor, not a total count
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 48,
  tickMs: 5 * 60_000, // 5 min/tick (the observe floor) — 4 h of sustained refusal
  eternalSentinel: { reason: 'declared Eternal Sentinel (spec §Watchers, P19): healer-only, constant per-round cost, escalates once', rateFloorMs: 10 * 60_000 },
  makeUnderPressure(f, sink) {
    return makeAgentIdentityAdoptionLoop(f, sink);
  },
};

/**
 * agent-identity-coherence-detector — the §2.2 continuous identity check. Under a
 * split that NEVER repairs (the pinned fixture), it raises exactly ONE `high`
 * item per sorted-fingerprint-set episode (after 2 consecutive `disagree`
 * reads, lease holder only) and at most ONE `medium` cannot-tell item per
 * online-but-unanswering peer; the attention store dedupes by id, so a restart
 * re-raising the same episode id never posts a second message.
 */
function makeAgentIdentityCoherenceDetector(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const RAISE_AFTER = 2;
  const key = 'agent-identity-coherence:raised-ids'; // the per-machine attention store (dedupe by id)
  const raised = (f.durableState.get(key) as Set<string> | undefined) ?? new Set<string>();
  f.durableState.set(key, raised);
  let consecutiveDisagree = 0;
  let cannotTellRounds = 0;
  return {
    tick() {
      sink.considered += 1;
      // The pressure: every round reads `disagree` on the SAME sorted set, and one online
      // peer never answers /provenance.
      consecutiveDisagree += 1;
      const episodeId = 'agent-identity-split:echo:A+B';
      if (consecutiveDisagree >= RAISE_AFTER && !raised.has(episodeId)) {
        raised.add(episodeId);
        sink.emit({ verb: 'escalate', target: episodeId });
      }
      cannotTellRounds += 1;
      const ctId = 'agent-identity-cannot-tell:echo:m_slow';
      if (cannotTellRounds >= 10 && !raised.has(ctId)) {
        raised.add(ctId);
        sink.emit({ verb: 'escalate', target: ctId });
      }
    },
  };
}

const agentIdentityCoherenceDetector: SelfActionController = {
  id: 'agent-identity-coherence-detector',
  actionVerb: 'split-escalate',
  models: 'src/core/AgentIdentityCoherence.ts (IdentityCoherenceDetector — one item per sorted-set episode after 2 consecutive disagree reads, holder-only; one cannot-tell item per peer after 10 online rounds)',
  modelsPath: 'src/core/AgentIdentityCoherence.ts',
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeAgentIdentityCoherenceDetector(f, sink),
  },
  boundK: 2, // one split item + one cannot-tell item while the episode persists
  perTargetBoundK: 1,
  ticks: 60,
  tickMs: 5 * 60_000, // 5 min/tick — 5 h of a split that never repairs
  makeUnderPressure(f, sink) {
    return makeAgentIdentityCoherenceDetector(f, sink);
  },
};

/**
 * telegram-origin-forward-ladder — a2a-single-agent-identity §4.2 (ACT-058).
 * A reply from a machine that does not hold the serving lease is forwarded to
 * the lease holder: ONE attempt inside the reply request, then a durable hold
 * whose quick ladder retries from the 5 s boot tick at +10 s and +20 s (the
 * ladder state lives in the held row's `holdDetail.ladder`, restart-surviving),
 * then the EXISTING 15-minute `reserveRecoveryAttempt` schedule until the
 * operation's 6 h deadline expires it (`expireOperation`, reported once). Under
 * a holder that always refuses, one held reply therefore costs at most
 * 1 + 2 + 24 = 27 forward attempts, horizon-independent: past the deadline the
 * row is `expired` and nothing fires again. Real source:
 * src/messaging/telegram-origin/OriginForwardToHolder.ts (nextLadderState,
 * recoverForwardedHold) + TelegramOriginRuntime.runForwardLadder/recoverHeld.
 */
const telegramOriginForwardLadder: SelfActionController = {
  id: 'telegram-origin-forward-ladder', actionVerb: 'retry-forward-to-holder',
  models: 'OriginForwardToHolder.nextLadderState (two quick steps, +10 s/+20 s, persisted in holdDetail.ladder) then OriginStoreBackend.reserveRecoveryAttempt (15-min interval) until expireOperation at the 6 h deadline.',
  modelsPath: 'src/messaging/telegram-origin/OriginForwardToHolder.ts',
  boundK: 27, perTargetBoundK: 27, ticks: 6_000, tickMs: 5_000, // 8h20m horizon > the 6 h deadline
  restartPosture: { pressureSurvives: true, restartUnderPressure: makeTelegramOriginForwardLadderPressure },
  makeUnderPressure: makeTelegramOriginForwardLadderPressure,
};
function makeTelegramOriginForwardLadderPressure(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const LADDER_DELAYS_MS = [10_000, 20_000], SCHEDULE_MS = 15 * 60_000, DEADLINE_MS = 6 * 60 * 60_000;
  return { tick() {
    sink.considered++;
    if (!f.targetAlwaysRejects()) return;
    const now = f.clock.nowMs();
    // The held row (durable): prepared at the first pressured tick; `ladder` + `nextAttemptAt` persist across reconstruction.
    let row = f.durableState.get('origin-forward:row') as { preparedAt: number; ladderAttempts: number; nextAt: number | null; state: 'held' | 'expired' } | undefined;
    if (!row) {
      sink.emit({ verb: 'retry-forward-to-holder', target: 'op-1' }); // the one in-request attempt
      row = { preparedAt: now, ladderAttempts: 0, nextAt: now + LADDER_DELAYS_MS[0], state: 'held' };
      f.durableState.set('origin-forward:row', row); return;
    }
    if (row.state === 'expired') return;
    if (now - row.preparedAt >= DEADLINE_MS) { row.state = 'expired'; f.durableState.set('origin-forward:row', row); return; } // expireOperation
    if (row.nextAt === null || now < row.nextAt) return;
    sink.emit({ verb: 'retry-forward-to-holder', target: 'op-1' });
    if (row.ladderAttempts < LADDER_DELAYS_MS.length) {
      row.ladderAttempts += 1; // nextLadderState
      row.nextAt = row.ladderAttempts < LADDER_DELAYS_MS.length ? now + LADDER_DELAYS_MS[row.ladderAttempts] : now + SCHEDULE_MS; // exhausted → the 15-min schedule
    } else row.nextAt = now + SCHEDULE_MS; // reserveRecoveryAttempt
    f.durableState.set('origin-forward:row', row);
  } };
}

/**
 * a2a-peer-dark-raise — the reworked A2ARedeliverySentinel's §3 dark pass
 * (docs/specs/a2a-single-agent-identity.md §3.2–3.3). The pressure: two peers
 * whose queued messages never get acknowledged (the relay queues forever, no
 * inbound, no delivered verdict), while my own relay stays connected on the
 * awake machine. Each 15-min tick re-reads the ledger, heals (reconnect is a
 * no-op while connected; one presence refresh; self-check `ok`) and would raise
 * the per-peer item. Convergence shape: ONE item per (peer, episode) — the open
 * episode is the latch (deterministic id `a2a-peer-dark:<agent>:<peerFp>`), the
 * per-peer 12 h cooldown brakes a re-raise after a resolve, and a restart
 * REBUILDS the episode from the durable OPEN item (attentionState) instead of
 * raising again. Sustained pressure converges to exactly one emit per peer; a
 * longer horizon adds nothing while the episode persists.
 */
const a2aPeerDarkRaise: SelfActionController = {
  id: 'a2a-peer-dark-raise',
  actionVerb: 'escalate-dark-peer',
  models: 'src/monitoring/A2ARedeliverySentinel.ts (darkPass — episode latch + inCooldown + episodeFor restart rebuild)',
  modelsPath: 'src/monitoring/A2ARedeliverySentinel.ts',
  boundK: 2, // 2 dark peers → at most one item each while the episode persists
  perTargetBoundK: 1,
  ticks: 96,
  tickMs: 15 * 60_000, // 15-min sweep — 24 h of a peer that never answers
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeA2aPeerDarkRaise(f, sink),
  },
  makeUnderPressure(f, sink) {
    return makeA2aPeerDarkRaise(f, sink);
  },
};

function makeA2aPeerDarkRaise(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const PEERS = ['peer-A', 'peer-B'];
  const COOLDOWN_MS = 12 * 60 * 60_000;
  // Durable per-peer item state (the attention store the real sentinel reads
  // through `attentionState`): 'OPEN' while the episode persists, plus the last
  // raise time for the cooldown. A fresh instance holds NO in-memory episodes.
  const itemKey = (p: string) => `a2a-peer-dark:item:${p}`;
  const raisedAtKey = (p: string) => `a2a-peer-dark:raisedAt:${p}`;
  const episodes = new Set<string>();
  return {
    tick() {
      sink.considered += 1;
      // The relay stays connected: no aggregate, no reconnect; the heal's
      // presence refresh and self-check are side-effect-free here.
      for (const peer of PEERS) {
        // The pressure: the peer is dark with queued rows every tick
        // (targetAlwaysRejects — nothing ever acknowledges).
        if (!f.targetAlwaysRejects()) continue;
        if (episodes.has(peer)) continue; // open in-process episode — the latch
        // Restart rebuild (episodeFor): a durable OPEN item re-arms the latch
        // without a second raise.
        if (f.durableState.get(itemKey(peer)) === 'OPEN') { episodes.add(peer); continue; }
        // Cooldown (inCooldown): a resolved item's last update inside 12 h brakes a re-raise.
        const lastRaisedAt = (f.durableState.get(raisedAtKey(peer)) as number | undefined) ?? Number.NEGATIVE_INFINITY;
        if (f.clock.nowMs() - lastRaisedAt < COOLDOWN_MS) continue;
        sink.emit({ verb: 'escalate-dark-peer', target: peer });
        episodes.add(peer);
        f.durableState.set(itemKey(peer), 'OPEN');
        f.durableState.set(raisedAtKey(peer), f.clock.nowMs());
      }
    },
  };
}

/**
 * Lifeline-ingress restart-signal writer (docs/specs/telegram-internal-route-lifeline-secret.md
 * "The restart-signal budget"). An unverified request on the internal Telegram
 * routes — which any Bearer holder can produce at any rate — makes the server
 * write the lifeline-restart signal. Convergence shape: a PERSISTED gap between
 * writes (`lastSignalAt` in the guard state: 12 h while unarmed, 24 h once
 * armed), so the write rate is floored however fast requests arrive and
 * however often the server restarts. The model drives the tighter 12 h floor.
 */
const lifelineIngressRestartSignal: SelfActionController = {
  id: 'lifeline-ingress-restart-signal',
  actionVerb: 'restart-signal-lifeline',
  models: 'src/server/LifelineIngressGuard.ts (evaluate + bootNudge + spendSignalBudget — persisted lastSignalAt, SIGNAL_GAP_UNARMED_MS / SIGNAL_GAP_ARMED_MS)',
  modelsPath: 'src/server/LifelineIngressGuard.ts',
  delegatedGiveUp: 'the persisted 12 h signal gap, plus the lifeline ignoring a signal that targets its own version and its own shared daily restart cap of three',
  boundK: Number.POSITIVE_INFINITY, // exempt — bounded by the rate floor, not a total count
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 2880, // one unverified request a minute for 48 h
  tickMs: 60_000,
  eternalSentinel: {
    reason: 'a lifeline that stays on older code must keep being asked to restart; the request rate is attacker-chosen, so only a persisted rate floor bounds it',
    rateFloorMs: 12 * 60 * 60_000,
  },
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeLifelineIngressRestartSignal(f, sink),
  },
  makeUnderPressure: (f, sink) => makeLifelineIngressRestartSignal(f, sink),
};

function makeLifelineIngressRestartSignal(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const GAP_MS = 12 * 60 * 60_000;
  const KEY = 'lifeline-ingress:lastSignalAt'; // the guard state file's lastSignalAt
  return {
    tick() {
      sink.considered += 1;
      // The pressure: an unverified request every tick, and a lifeline that
      // never proves itself (the guard stays unarmed).
      if (!f.targetAlwaysRejects()) return;
      const last = (f.durableState.get(KEY) as number | undefined) ?? Number.NEGATIVE_INFINITY;
      if (f.clock.nowMs() - last < GAP_MS) return;
      f.durableState.set(KEY, f.clock.nowMs());
      sink.emitTimesMs.push(f.clock.nowMs());
      sink.emit({ verb: 'restart-signal-lifeline', target: 'lifeline' });
    },
  };
}

/**
 * Lifeline secret-refusal redrive (same spec, "If a refusal reaches a real
 * lifeline, the message is held, not lost"). While the server refuses the
 * lifeline's secret, queue replay keeps retrying the held message — it must
 * never be dropped. Convergence shape: single-flight replay, the pass stops at
 * the first refusal, and the gap between passes doubles from 1 minute to a
 * 15-minute cap. Never faster than one pass a minute; the backoff state is
 * in-memory, so a lifeline restart begins again at the 1-minute floor.
 */
const lifelineSecretRefusalRedrive: SelfActionController = {
  id: 'lifeline-secret-refusal-redrive',
  actionVerb: 'retry-held-forward',
  models: 'src/lifeline/TelegramLifeline.ts (replayQueue — replayInFlight, secretRefusedLastAt, secretRefusalBackoffMs 1→15 min)',
  modelsPath: 'src/lifeline/TelegramLifeline.ts',
  delegatedGiveUp: 'none by design — a held operator message is never dropped; the brake is the 1-minute floor doubling to a 15-minute cap, plus one user notice per episode',
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 5760, // the 15 s replay tick for 24 h
  tickMs: 15_000,
  eternalSentinel: {
    reason: 'dropping a held operator message is the failure this path exists to prevent, so it retries for as long as the refusal lasts, at a floored and backing-off rate',
    rateFloorMs: 60_000,
  },
  restartPosture: {
    pressureSurvives: false,
    resetSafeReason: 'A restarted lifeline starts a new refusal episode at the 1-minute floor; the floor itself is never undercut because the first replay pass after a restart is itself the first attempt.',
  },
  makeUnderPressure(f, sink) {
    const FLOOR_MS = 60_000;
    const CAP_MS = 15 * 60_000;
    let lastPassAt = Number.NEGATIVE_INFINITY;
    let passes = 0;
    return {
      tick() {
        sink.considered += 1;
        if (!f.targetAlwaysRejects()) return; // the server refuses every forward
        const backoff = Math.min(CAP_MS, FLOOR_MS * 2 ** Math.min(Math.max(0, passes - 1), 10));
        if (f.clock.nowMs() - lastPassAt < backoff) return;
        lastPassAt = f.clock.nowMs();
        passes += 1;
        sink.emitTimesMs.push(f.clock.nowMs());
        sink.emit({ verb: 'retry-held-forward', target: 'server' });
      },
    };
  },
};

/**
 * Threadline connect-enable (upgrades/side-effects/threadline-enable-without-restart.md).
 * POST /threadline/pairing/enable, and its own deferred retry, write the supervised-restart
 * flag when pairing is off. The model drives the REAL `decideConnectEnable` under the worst
 * case for this controller: the route is called every minute, pairing never comes up, no
 * session is busy (busy only withholds), and the flag is consumed at once but the process
 * keeps running (a wedged restart). Convergence shape: a PERSISTED request record (time +
 * pid) gives a 10-minute floor between requests, whether or not the process restarts; a
 * waiting flag adds no second request.
 */
const threadlineConnectEnableRestart: SelfActionController = {
  id: 'threadline-connect-enable-restart',
  actionVerb: 'restart-request-server',
  models: 'src/threadline/connectEnable.ts (decideConnectEnable — persisted request record, CONNECT_ENABLE_RESTART_COOLDOWN_MS; ConnectEnableController deferred retry capped at CONNECT_ENABLE_DEFER_MAX_MS)',
  modelsPath: 'src/threadline/connectEnable.ts',
  delegatedGiveUp: 'the persisted 10-minute cooldown record; the deferred retry gives up after 5 minutes; every request is caller-driven (the agent, at its person\'s request)',
  boundK: Number.POSITIVE_INFINITY, // exempt — bounded by the rate floor, not a total count
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 2880, // the route called every minute for 48 h
  tickMs: 60_000,
  eternalSentinel: {
    reason: 'the route answers a caller who may keep asking while pairing never comes up; only the persisted cooldown floors how often that becomes a restart request',
    rateFloorMs: CONNECT_ENABLE_RESTART_COOLDOWN_MS,
  },
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeThreadlineConnectEnableRestart(f, sink),
  },
  makeUnderPressure: (f, sink) => makeThreadlineConnectEnableRestart(f, sink),
};

function makeThreadlineConnectEnableRestart(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const RECORD = 'connect-enable:record';
  const PENDING = 'connect-enable:flag-pending';
  const PIDS = 'connect-enable:pid-counter';
  // A new instance is a new process (restartUnderPressure): a new pid, the same durable record.
  const pid = ((f.durableState.get(PIDS) as number | undefined) ?? 1000) + 1;
  f.durableState.set(PIDS, pid);
  return {
    tick() {
      sink.considered += 1;
      // The supervisor consumes a waiting flag before the next call (worst case: no restart follows).
      f.durableState.set(PENDING, false);
      const now = f.clock.nowMs();
      const d = decideConnectEnable({
        ready: false, // pairing never comes up
        bootRelayEnabled: false, bootPairingEnabled: false, ownsRelayAfterRestart: true,
        restartAlreadyPending: f.durableState.get(PENDING) === true,
        lastRequest: (f.durableState.get(RECORD) as ConnectEnableRequestRecord | undefined) ?? null,
        pid, now, blockers: [], supervised: true,
      });
      if (!d.requestRestart) return;
      f.durableState.set(RECORD, { requestedAt: new Date(now).toISOString(), pid });
      f.durableState.set(PENDING, true);
      sink.emitTimesMs.push(now);
      sink.emit({ verb: 'restart-request-server', target: 'server' });
    },
  };
}

/**
 * system-topic-adoption — a standby copies the lease holder's Updates /
 * Attention / Agent Health topic ids (src/messaging/SystemTopicAdoption.ts,
 * 30-min cadence). Convergence shape: adoption is idempotent (unchanged id ⇒
 * no write) and the per-kind per-boot cap (withAdoptionBrake) is the brake —
 * under the pinned worst case, a holder whose record FLAPS (a new id for every
 * kind on every pass), the loop adopts at most MAX_ADOPTS_PER_KIND_PER_BOOT
 * per kind and then holds, never following the flap.
 */
const systemTopicAdoption: SelfActionController = {
  id: 'system-topic-adoption',
  actionVerb: 'refresh-system-topic', // 'refresh' detector token: the local record is refreshed from the holder
  models: 'src/messaging/SystemTopicAdoption.ts (adoptHolderSystemTopics + withAdoptionBrake; startSystemTopicAdoptionLoop 30-min cadence)',
  modelsPath: 'src/messaging/SystemTopicAdoption.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The per-boot cap re-arms on restart; restarts are operator/updater-driven and themselves dampened (restart cascade dampener), so a flapping holder costs at most MAX_ADOPTS_PER_KIND_PER_BOOT adopts per kind per restart.' },
  boundK: 3 * MAX_ADOPTS_PER_KIND_PER_BOOT, // three kinds × the per-kind cap
  perTargetBoundK: MAX_ADOPTS_PER_KIND_PER_BOOT,
  ticks: 50,
  tickMs: SYSTEM_TOPIC_ADOPTION_INTERVAL_MS,
  makeUnderPressure(f, sink) {
    const local = new Map<string, number>();
    const adopt = withAdoptionBrake((key, topicId) => { local.set(key, topicId); sink.emit({ verb: 'refresh-system-topic', target: key }); });
    let pass = 0;
    return {
      tick() {
        sink.considered += 1;
        pass += 1;
        // The pinned worst case: the holder answers, but with a NEW id for every kind on every pass.
        const holder = f.targetAlwaysRejects()
          ? { updates: 1000 + pass, attention: 2000 + pass, agentHealth: 3000 + pass }
          : { updates: 1000, attention: 2000, agentHealth: 3000 };
        // The same pure core the async loop runs (planAdoption → braked adopt).
        for (const { kind, topicId } of planAdoption(readSystemTopicIds(k => local.get(k)), holder)) adopt(SYSTEM_TOPIC_STATE_KEYS[kind], topicId);
      },
    };
  },
};


// ── local-verify (spec docs/specs/local-verify-merge-authority.md; ACT-147) ──
// Every model below drives the SAME exported pure decision functions the real
// LocalVerifyService / StatusReconciler call (decideVerifyRetry, decideStarved,
// decideStart, decideMainHeadEnqueue, decideMainEnqueue, decideMainErrorRetry,
// admitStatusPost, postRetryDue, nextPostRetry, orderSubmissions,
// passBackoffDelay) — not re-implementations. Invariants the sink cannot express
// (per-minute cap, once-per-entry signals) are asserted inside the model by
// throwing, which fails the ratchet.

const LV_HEAD = 'a'.repeat(40);

/**
 * A stale peer-idle reading must not turn one red PR into an endless stream of
 * diagnostic dispatches. A busy refusal is durably terminal for that exact
 * key; after the 14-day marker retention ends, the 24-hour candidate window
 * has already closed. This model crosses both boundaries under persistent
 * peer refusal and survives reconstruction of the coordinator.
 */
const localVerifyFailedFileDiagnosis: SelfActionController = {
  id: 'local-verify-failed-file-diagnosis',
  actionVerb: 'spawn-diagnosis-peer',
  models: 'src/localVerify/FailedFileDiagnosisCoordinator.ts (tickOnce → reserve before diagnose; peer-busy terminal; fresh-record window)',
  modelsPath: 'src/localVerify/FailedFileDiagnosisCoordinator.ts',
  restartPosture: { pressureSurvives: true, restartUnderPressure(f, sink) {
    return localVerifyFailedFileDiagnosis.makeUnderPressure(f, sink);
  } },
  boundK: 1,
  perTargetBoundK: 1,
  ticks: 30,
  tickMs: 24 * 60 * 60_000,
  makeUnderPressure(f, sink) {
    const key = 'red-pr:exact-head-base';
    return { tick() {
      sink.considered += 1;
      const age = f.clock.nowMs();
      if (age >= 14 * 24 * 60 * 60_000) f.durableState.delete(key); // terminal retention expires
      if (age > 24 * 60 * 60_000 || f.durableState.has(key)) return;
      f.durableState.set(key, f.targetAlwaysRejects() ? 'done:peer-busy' : 'reserved');
      sink.emit({ verb: 'spawn-diagnosis-peer', target: key });
    } };
  },
};

/**
 * local-verify-error-rerun — an `error` verify outcome re-runs automatically at
 * most once per queue entry (per (pr, head)), then stops: the record stays
 * `error` until the head moves or someone asks. Pinned worst case: EVERY verify
 * errors (targetAlwaysRejects). Three queued PRs ⇒ exactly three automatic
 * re-runs, then nothing, horizon-independent.
 */
const localVerifyErrorRerun: SelfActionController = {
  id: 'local-verify-error-rerun',
  actionVerb: 'retry-errored-verify',
  models: 'src/localVerify/LocalVerifyService.ts (handleErrorRetry → decideVerifyRetry; pump → decideStart)',
  modelsPath: 'src/localVerify/LocalVerifyService.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The queue is in memory; after a restart an errored (pr, head) keeps its journaled error record, and a non-explicit request returns that record instead of re-running, so a restart adds no automatic re-run.' },
  boundK: 3,
  perTargetBoundK: 1,
  ticks: 40,
  tickMs: 30_000, // the service tick
  makeUnderPressure(f, sink) {
    const queue = [101, 102, 103].map((pr) => ({ pr, attempts: 0, errorRetries: 0, notBefore: undefined as number | undefined }));
    return {
      tick() {
        sink.considered += 1;
        const d = decideStart({ foreignHolders: 0, queue, now: f.clock.nowMs() });
        if (d.kind !== 'start') return;
        const [entry] = queue.splice(d.index, 1);
        entry.attempts += 1;
        if (!f.targetAlwaysRejects()) return; // a non-error outcome ends the entry
        const r = decideVerifyRetry(entry, 'error');
        if (r.action !== 're-run') return; // stays `error` until the head moves or someone asks
        entry.errorRetries = r.errorRetries;
        sink.emit({ verb: 'retry-errored-verify', target: `${entry.pr}:${LV_HEAD}` });
        queue.unshift(entry);
      },
    };
  },
};

/**
 * local-verify-capacity-requeue — a run that finds a foreign full suite holding
 * the slot waits in place 30 minutes, then re-queues at the front WITHOUT
 * counting an attempt. Pinned worst case (everySessionBusy): the foreign suite
 * starts right after the pre-start check, so every run waits the full 30 minutes
 * and re-queues, forever. A declared rate-floored loop: re-starts are ≥ 30 min
 * apart (one run at a time, each holding the slot for the full wait). Asserted in
 * the model: attempts never exceed 1 (requeues are not attempts) and the starved
 * signal fires at most once per entry — and does fire.
 */
const localVerifyCapacityRequeue: SelfActionController = {
  id: 'local-verify-capacity-requeue',
  actionVerb: 'retry-requeued-verify',
  models: 'src/localVerify/LocalVerifyService.ts (onExit requeue → decideVerifyRetry(…, "requeue"); checkStarved → decideStarved) + orchestrator.ts wait-in-place',
  modelsPath: 'src/localVerify/LocalVerifyService.ts',
  delegatedGiveUp: 'none needed: re-starts are floored by the 30-minute wait-in-place (one run at a time); the starved signal (once per entry, after 3 h) tells the operator',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The queue is in memory; a restart drops it and entries are re-queued lazily by the next request, so a restart re-arms at most one starved signal per entry and cannot shorten the wait-in-place floor.' },
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 48,
  tickMs: 5 * 60_000,
  eternalSentinel: { reason: 'a capacity-blocked verify re-queues (holders checked before every start; a busy suite slot at lane start re-queues); never an attempt, starved signal once per entry', rateFloorMs: LOCAL_VERIFY_LIMITS.waitInPlaceMs },
  makeUnderPressure(f, sink) {
    const t0 = f.clock.nowMs();
    const queue = [201, 202].map((pr) => ({ pr, attempts: 0, errorRetries: 0, firstQueuedAt: t0, starvedRaised: false, notBefore: undefined as number | undefined }));
    let running: { entry: (typeof queue)[number]; until: number } | null = null;
    let restarted = false;
    const starved = new Map<number, number>();
    return {
      tick() {
        sink.considered += 1;
        const now = f.clock.nowMs();
        if (running && now >= running.until && f.everySessionBusy()) {
          // The wait in place ran out with the suite still holding the slot: requeue, not an attempt.
          const r = decideVerifyRetry(running.entry, 'requeue');
          running.entry.attempts = r.attempts;
          queue.unshift(running.entry);
          running = null;
          restarted = true;
        }
        if (queue.length > 0) {
          const oldest = queue.reduce((a, b) => (a.firstQueuedAt <= b.firstQueuedAt ? a : b));
          const s = decideStarved(oldest, now);
          if (s.raise) {
            oldest.starvedRaised = true;
            starved.set(oldest.pr, (starved.get(oldest.pr) ?? 0) + 1);
            if (starved.get(oldest.pr)! > 1) throw new Error(`local-verify starved signal raised twice for pr ${oldest.pr}`);
          }
        }
        if (running) return;
        const d = decideStart({ foreignHolders: 0, queue, now }); // the suite starts right after this check
        if (d.kind !== 'start') return;
        const [entry] = queue.splice(d.index, 1);
        entry.attempts += 1;
        if (entry.attempts > 1) throw new Error(`local-verify capacity requeue counted as an attempt (pr ${entry.pr})`);
        running = { entry, until: now + LOCAL_VERIFY_LIMITS.waitInPlaceMs };
        if (restarted) {
          sink.emit({ verb: 'retry-requeued-verify', target: String(entry.pr) });
          sink.emitTimesMs.push(now);
        }
        if (now - t0 > LOCAL_VERIFY_LIMITS.starvedAfterMs + 30 * 60_000 && starved.size === 0) {
          throw new Error('local-verify starved signal never fired under sustained capacity pressure');
        }
      },
    };
  },
};

/** The shared `main`-verify pass driver: one reconcile pass per tick observes `headAt(pass)`. */
function makeMainVerifyPasses(
  f: PressureFixture,
  sink: ActionSink,
  opts: { headAt: (pass: number) => string; verifyErrors: boolean; recordTimes: boolean },
): { tick(): void } {
  let obs: MainHeadObservation = { head: null, since: 0, firstUnverifiedAt: null, handled: null, immediate: true };
  let pending: { headSha: string; notBefore?: number } | null = null;
  const errorRetries = new Map<string, number>();
  let pass = 0;
  return {
    tick() {
      sink.considered += 1;
      const now = f.clock.nowMs();
      const sha = opts.headAt(pass++);
      const h = decideMainHeadEnqueue(obs, sha, now);
      obs = h.next;
      if (h.enqueue) {
        const q = decideMainEnqueue({ sha, why: 'head-changed', inFlightMain: null, pendingMainHead: pending?.headSha ?? null });
        if (q.action !== 'skip') pending = { headSha: sha }; // push, or replace the pending one: never two
      }
      if (!pending) return;
      const d = decideStart({ foreignHolders: 0, queue: [pending], now });
      if (d.kind !== 'start') return;
      const run = pending;
      pending = null;
      sink.emit({ verb: 'retry-main-verify', target: run.headSha });
      if (opts.recordTimes) sink.emitTimesMs.push(now);
      if (!opts.verifyErrors) return;
      const r = decideMainErrorRetry({ priorRetries: errorRetries.get(run.headSha) ?? 0, mainPending: pending !== null, now });
      errorRetries.set(run.headSha, r.retries);
      if (r.requeue) pending = { headSha: run.headSha, notBefore: r.notBefore };
    },
  };
}

/**
 * local-verify-main-schedule — the post-merge `main` verify: at most one pending,
 * one verify per head, and an `error` re-queues with backoff at most 3 times per
 * head. Pinned worst case: `main` sits on one head and EVERY verify errors
 * (targetAlwaysRejects) ⇒ 1 + 3 = 4 verifies, then nothing, horizon-independent.
 */
const localVerifyMainSchedule: SelfActionController = {
  id: 'local-verify-main-schedule',
  actionVerb: 'retry-main-verify',
  models: 'src/localVerify/LocalVerifyService.ts (noteMainHead → decideMainHeadEnqueue; enqueueMain → decideMainEnqueue; completeMain → decideMainErrorRetry) + mainHealth.ts',
  modelsPath: 'src/localVerify/LocalVerifyService.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Boot skips the debounce once (immediate), so a restart costs at most one main verify plus its bounded error re-runs; restarts are operator/updater-driven and dampened.' },
  boundK: 1 + MAIN_VERIFY_LIMITS.errorRetries,
  perTargetBoundK: 1 + MAIN_VERIFY_LIMITS.errorRetries,
  ticks: 60,
  tickMs: RECONCILER_LIMITS.intervalMs, // the reconcile pass feeds noteMainHead
  makeUnderPressure(f, sink) {
    return makeMainVerifyPasses(f, sink, { headAt: () => LV_HEAD, verifyErrors: f.targetAlwaysRejects(), recordTimes: false });
  },
};

/**
 * local-verify-main-debounce — the same scheduling under a `main` head that never
 * settles (targetAlwaysRejects: every pass reads a new head). The debounce never
 * matures, so the 30-minute cap paces it: at most one head-changed verify per
 * debounce window (declared floor 10 min; the cap makes the real gap ≥ 30 min).
 * Error re-runs are bounded per head by local-verify-main-schedule.
 */
const localVerifyMainDebounce: SelfActionController = {
  id: 'local-verify-main-debounce',
  actionVerb: 'retry-main-verify',
  models: 'src/localVerify/LocalVerifyService.ts (noteMainHead → decideMainHeadEnqueue debounce 10 min capped at 30; enqueueMain → decideMainEnqueue)',
  modelsPath: 'src/localVerify/LocalVerifyService.ts',
  delegatedGiveUp: 'none needed: the debounce cap (30 min) floors head-changed verifies; at most one is ever pending',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Boot skips the debounce once (immediate), so each restart adds at most one head-changed verify; restarts are operator/updater-driven and dampened.' },
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 180,
  tickMs: RECONCILER_LIMITS.intervalMs,
  eternalSentinel: { reason: 'a never-settling main head gets at most one verify per debounce window', rateFloorMs: MAIN_VERIFY_LIMITS.debounceMs },
  makeUnderPressure(f, sink) {
    return makeMainVerifyPasses(f, sink, {
      headAt: (pass) => (f.targetAlwaysRejects() ? pass.toString(16).padStart(40, '0') : LV_HEAD),
      verifyErrors: false,
      recordTimes: true,
    });
  },
};

/**
 * local-verify-status-post — the reconciler's status posts. Pinned worst case:
 * EVERY post answers 403 and GitHub's settings are unreadable
 * (targetAlwaysRejects), with 40 open heads of which 10 must withdraw a
 * `success`. A failed post is retried only by the 60-second pass, after its
 * per-head backoff (30 s doubling, capped at 10 min) — so it is a rate-floored
 * loop: at most one posting batch per pass. Asserted in the model: non-withdrawal
 * posts never exceed 30 in a rolling minute, and withdrawals (exempt from the cap)
 * never exceed the number of withdrawing heads in one pass.
 */
const localVerifyStatusPost: SelfActionController = {
  id: 'local-verify-status-post',
  actionVerb: 'retry-status-post',
  models: 'src/localVerify/StatusReconciler.ts (passInner → postRetryDue + orderSubmissions; send → admitStatusPost, nextPostRetry)',
  modelsPath: 'src/localVerify/StatusReconciler.ts',
  delegatedGiveUp: 'none needed: posts ride only the 60-second pass, the 30/minute cap bounds non-withdrawals, and withdrawals are bounded by the heads that hold a success',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'Retries, the post window and the observed cache are in memory and rebuilt from GitHub after a restart, never by blind re-posting; the first pass is still under the 30/minute cap with withdrawals bounded by heads.' },
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 15,
  tickMs: RECONCILER_LIMITS.intervalMs,
  eternalSentinel: { reason: 'at most one posting batch per 60-second pass; the batch is capped (30/min, withdrawals bounded by heads)', rateFloorMs: RECONCILER_LIMITS.intervalMs },
  makeUnderPressure(f, sink) {
    const heads = Array.from({ length: 40 }, (_, k) => ({ head: k.toString(16).padStart(40, 'b'), withdraw: k < 10 }));
    const withdrawing = heads.filter((h) => h.withdraw).length;
    const retries = new Map<string, { attempts: number; nextAt: number }>();
    const settled = new Set<string>();
    let postTimes: number[] = [];
    let ordinaryTimes: number[] = [];
    return {
      tick() {
        sink.considered += 1;
        const now = f.clock.nowMs();
        const due = heads.filter((h) => !settled.has(h.head) && postRetryDue(retries.get(h.head), now));
        let posted = 0;
        let withdrawals = 0;
        for (const t of orderSubmissions(due)) {
          const a = admitStatusPost({ withdrawal: t.withdraw, postTimes, now });
          postTimes = a.postTimes;
          if (!a.admit) continue; // deferred to the next pass
          postTimes.push(now);
          posted += 1;
          if (t.withdraw) withdrawals += 1;
          else ordinaryTimes.push(now);
          if (f.targetAlwaysRejects()) retries.set(t.head, nextPostRetry(retries.get(t.head), now));
          else settled.add(t.head);
        }
        ordinaryTimes = ordinaryTimes.filter((x) => now - x < 60_000);
        if (ordinaryTimes.length > RECONCILER_LIMITS.postsPerMinute) throw new Error(`local-verify posted ${ordinaryTimes.length} non-withdrawal statuses in a minute (cap ${RECONCILER_LIMITS.postsPerMinute})`);
        if (withdrawals > withdrawing) throw new Error(`local-verify posted ${withdrawals} withdrawals for ${withdrawing} withdrawing heads`);
        if (posted === 0) return;
        sink.emit({ verb: 'retry-status-post', target: 'status-post-pass' });
        sink.emitTimesMs.push(now);
      },
    };
  },
};

/**
 * local-verify-status-pass-backoff — a failed open-PR listing posts nothing and
 * backs the whole pass off (2 min doubling, capped at 15). Pinned worst case:
 * EVERY listing fails (targetAlwaysRejects). Listing attempts (and the settings
 * read that precedes each) are ≥ 2 minutes apart.
 */
const localVerifyStatusPassBackoff: SelfActionController = {
  id: 'local-verify-status-pass-backoff',
  actionVerb: 'retry-pr-list',
  models: 'src/localVerify/StatusReconciler.ts (passInner nextPassAt gate; backoffPass → passBackoffDelay)',
  modelsPath: 'src/localVerify/StatusReconciler.ts',
  delegatedGiveUp: 'none needed: the pass backoff floors listing attempts at 2 minutes (15 at steady state) and a failed listing posts nothing',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'A restart begins with one immediate pass and then re-enters the same backoff after its first failure; restarts are operator/updater-driven and dampened.' },
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 60,
  tickMs: RECONCILER_LIMITS.intervalMs,
  eternalSentinel: { reason: 'a failing PR listing is retried at most once per backoff interval (2 to 15 minutes)', rateFloorMs: RECONCILER_LIMITS.passBackoffBaseMs },
  makeUnderPressure(f, sink) {
    let failures = 0;
    let nextPassAt = 0;
    return {
      tick() {
        sink.considered += 1;
        const now = f.clock.nowMs();
        if (now < nextPassAt) return;
        sink.emit({ verb: 'retry-pr-list', target: 'open-pr-list' });
        sink.emitTimesMs.push(now);
        if (!f.targetAlwaysRejects()) { failures = 0; nextPassAt = 0; return; }
        failures += 1;
        nextPassAt = now + passBackoffDelay(failures);
      },
    };
  },
};


/**
 * local-verify-flake-rerun — the isolation re-run inside one verify: a lane whose only
 * problem is 1..3 failed files re-runs exactly those files once each, and the cap (3)
 * covers the whole verify. Pinned worst case (targetAlwaysRejects): every lane of every
 * verify has 2 failing files and every re-run fails again. Per verify: lane 1 re-runs 2,
 * lane 2 re-runs none (only 1 left of the cap), lane 3 none ⇒ ≤ 3 re-runs, each file
 * once. The model drives ONE verify (verifies themselves are bounded by the queue's own
 * controllers), so the bound is horizon-independent.
 */
const localVerifyFlakeRerun: SelfActionController = {
  id: 'local-verify-flake-rerun',
  actionVerb: 'retry-failed-test-file',
  models: 'src/localVerify/orchestrator.ts (isolationRerun ← decideIsolationRerun, cap LOCAL_VERIFY_LIMITS.isolationRerunMaxFiles per verify)',
  modelsPath: 'src/localVerify/orchestrator.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The re-run budget lives inside one verify run (the child process); a restart ends that run, and the next run is a new verify bounded by the queue controllers.' },
  boundK: LOCAL_VERIFY_LIMITS.isolationRerunMaxFiles,
  perTargetBoundK: 1,
  ticks: 3, // one tick per lane of a single verify
  tickMs: 10 * 60_000,
  makeUnderPressure(f, sink) {
    let budget = LOCAL_VERIFY_LIMITS.isolationRerunMaxFiles;
    let lane = 0;
    return {
      tick() {
        sink.considered += 1;
        const files = [`tests/l${lane}/a.test.ts`, `tests/l${lane}/b.test.ts`];
        const report: ParsedLaneReport = { files: new Map(files.map((x) => [x, { passed: 1, failed: f.targetAlwaysRejects() ? 1 : 0, skipped: 0, todo: 0 }])) };
        lane += 1;
        const d = decideIsolationRerun({ report, laneFiles: files, maxFiles: LOCAL_VERIFY_LIMITS.isolationRerunMaxFiles, budgetLeft: budget });
        budget -= d.rerun.length;
        for (const file of d.rerun) sink.emit({ verb: 'retry-failed-test-file', target: file });
      },
    };
  },
};

/**
 * local-verify-main-fair-share — the single verify slot shared between `main` and PRs.
 * Pinned worst case (targetAlwaysRejects): `main` gets a new head before every start and
 * PR verifies are always waiting; each verify holds the slot 45 minutes. With `main`
 * healthy a `main` verify goes ahead of waiting PRs only once its oldest unverified merge
 * is ≥ 90 min old; a green main verify clears that age. So `main` starts are ≥ 90 min
 * apart and PRs keep starting. Asserted in the model: a PR starts between any two `main`
 * starts, and the oldest unverified merge never waits past 3 hours.
 */
const localVerifyMainFairShare: SelfActionController = {
  id: 'local-verify-main-fair-share',
  actionVerb: 'retry-main-verify',
  models: 'src/localVerify/LocalVerifyService.ts (pump → decideStart with fairShare: oldestUnverifiedMainAt, lastStartWasMain, main health)',
  modelsPath: 'src/localVerify/LocalVerifyService.ts',
  delegatedGiveUp: 'none needed: with PRs waiting, a healthy main start is floored at 90 min of its oldest unverified merge (unhealthy: every other start); with no PR waiting the slot is otherwise idle',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The unverified-age clock restarts at boot (the boot main verify skips the debounce once), then the 90-minute rule applies again.' },
  boundK: Number.POSITIVE_INFINITY,
  perTargetBoundK: Number.POSITIVE_INFINITY,
  ticks: 96,
  tickMs: 15 * 60_000,
  eternalSentinel: { reason: 'with PR verifies waiting and main healthy, main verifies start only once the oldest unverified merge is 90 min old', rateFloorMs: MAIN_FAIR_SHARE_MS },
  makeUnderPressure(f, sink) {
    let headN = 0;
    let running: { kind?: 'main'; until: number } | null = null;
    let oldestUnverifiedMainAt: number | null = null;
    let lastStartWasMain = false;
    let prSinceMain = true;
    return {
      tick() {
        sink.considered += 1;
        const now = f.clock.nowMs();
        if (oldestUnverifiedMainAt === null) oldestUnverifiedMainAt = now; // a new merge lands every pass
        if (running && now >= running.until) {
          if (running.kind === 'main') oldestUnverifiedMainAt = null; // its green verify covers the backlog
          running = null;
        }
        if (oldestUnverifiedMainAt !== null && now - oldestUnverifiedMainAt > 3 * 60 * 60_000) {
          throw new Error('local-verify let a healthy main wait past the 3 h unverified alarm');
        }
        if (running) return;
        const queue: Array<{ kind?: 'main'; head?: string }> = [
          { kind: 'main', head: (headN++).toString(16).padStart(40, '0') },
          ...(f.targetAlwaysRejects() ? [{}, {}] : []),
        ];
        const d = decideStart({ foreignHolders: 0, queue, now, fairShare: { mainHealthy: true, oldestUnverifiedMainAt, lastStartWasMain } });
        if (d.kind !== 'start') return;
        const e = queue[d.index];
        lastStartWasMain = e.kind === 'main';
        running = { ...(e.kind ? { kind: e.kind } : {}), until: now + 45 * 60_000 };
        if (e.kind === 'main') {
          if (f.targetAlwaysRejects() && !prSinceMain) throw new Error('local-verify started two main verifies in a row while PRs waited');
          prSinceMain = false;
          sink.emit({ verb: 'retry-main-verify', target: e.head! });
          sink.emitTimesMs.push(now);
        } else {
          prSinceMain = true;
        }
      },
    };
  },
};

/**
 * local-verify-merge-handoff — the merge line (CMT-980): a green PR record is handed
 * to the merge watcher at once (one hand-off per record, one open hold at a time,
 * never a retry: a refusal is left to the watcher's regular ticks). Pinned worst
 * case (targetAlwaysRejects): the watcher refuses EVERY hand-off. Three PRs go green
 * ⇒ exactly three hand-offs, one per PR, then nothing, horizon-independent — a
 * refused record is terminal for its (pr, head) and is never re-offered.
 */
const localVerifyMergeHandoff: SelfActionController = {
  id: 'local-verify-merge-handoff',
  actionVerb: 'nudge-watcher-merge',
  models: 'src/localVerify/LocalVerifyService.ts (offerMerge → decideMergeHandoff; the hold is released by the watcher answer or MERGE_LINE.handoffMaxMs)',
  modelsPath: 'src/localVerify/LocalVerifyService.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The hold and the hand-off counters are in memory; a record is journaled before it is offered, and the boot rebuild never re-offers journaled records, so a restart adds no hand-off.' },
  boundK: 3,
  perTargetBoundK: 1,
  ticks: 40,
  tickMs: 30_000,
  makeUnderPressure(f, sink) {
    // One green record per PR arrives over the first ticks; a refused hand-off closes the hold.
    const pending = [101, 102, 103];
    const offered = new Set<number>();
    let holdOpen = false;
    return {
      tick() {
        sink.considered += 1;
        if (holdOpen) { holdOpen = false; return; } // the watcher answered (refused): the hold is released
        const pr = pending.find((n) => !offered.has(n));
        if (pr === undefined) return; // every record was offered once; nothing re-offers a recorded head
        const d = decideMergeHandoff({ outcome: 'success', wired: true, stopped: false, holdOpen });
        if (!d.handoff) return;
        offered.add(pr);
        holdOpen = true;
        sink.emit({ verb: 'nudge-watcher-merge', target: `${pr}:${LV_HEAD}` });
        if (!f.targetAlwaysRejects()) holdOpen = false; // a merge lands: the hold closes the same way
      },
    };
  },
};


/**
 * overload-admission-self-help — trustworthy-machine-load Part C (C1/C4). The
 * real WorkAdmission is driven by the 15 s load verdict: under the pinned
 * worst case (every sample `saturated`, forever) it CLOSES once (a state
 * transition, not an emit), fires the deterministic self-help notice ONCE per
 * closed episode (an attention item naming the top processes), and then holds:
 * no reopen (the 5-good-sample hysteresis never clears), no second item until
 * a genuine reopen starts a new episode. Models the REAL class (no copy of its
 * logic) with a virtual clock; the recovery slot is never touched by this path.
 */
const overloadAdmissionSelfHelp: SelfActionController = {
  id: 'overload-admission-self-help',
  actionVerb: 'overload-notify',
  models: 'src/core/workAdmission.ts (WorkAdmission.observe — close on saturated/impaired, self-help once per closed episode, reopen only after 5 good samples)',
  modelsPath: 'src/core/workAdmission.ts',
  restartPosture: {
    pressureSurvives: false,
    resetSafeReason:
      'The closed-episode latch is process-local by design (the audit stream records it; nothing re-reads it). A reconstruction under the same overload cannot re-fire immediately: the sampler needs 2 of 3 fresh samples before any non-unknown verdict (≥30 s) and WorkAdmission needs 3 consecutive overloaded samples (45 s) before self-help, so a restart loop is rate-floored at one item per ≥75 s and the supervisor restart backoff bounds the loop itself.',
  },
  boundK: 1,
  perTargetBoundK: 1,
  ticks: 40,
  tickMs: 15_000, // the real sample cadence (LOAD_SAMPLE_INTERVAL_MS)
  makeUnderPressure(f, sink) {
    const wa = new WorkAdmission({
      config: () => ({ enabled: true, dryRun: false, reopenAfterGoodSamples: 5, selfHelpAfterSaturatedSamples: 3 }),
      // Never acquired on this path (no operator admit in the model); a real
      // semaphore object is required by the type, pointed at a tmp path.
      recoverySlot: new HostSpawnSemaphore({ holdersPath: path.join(os.tmpdir(), 'instar-overload-admission-model-slot.json'), cap: 1 }),
      now: () => f.clock.nowMs(),
      onSustainedOverload: () => { sink.emit({ verb: 'notify', target: 'overload-self-help' }); },
    });
    return {
      tick() {
        sink.considered += 1;
        wa.observe('saturated'); // the worst case: overloaded on every sample, never clearing
      },
    };
  },
};

/**
 * interactive-login-expired-swap — CMT-1008. A topic session stuck at Claude Code's expired-login
 * screen is swapped onto a signed-in account. Under the pinned fixture the swap is always refused
 * (targetAlwaysRejects: no eligible alternate / refresh refused) and the session never leaves the
 * screen, so the monitor re-offers it forever. The REAL brake (`decideLoginExpiredSwap`, the same
 * function the recovery calls): one attempt per 10-min cooldown, at most 3 per session, then it
 * stays put. A successful swap resets the budget, but only after the dead source account is marked
 * needs-reauth and excluded, so successes are bounded by the pool size (not modelled: the fixture
 * refuses every swap).
 */
/**
 * replicated-store-reconciler — docs/specs/statesync-writer-agnostic-reconciler.md §4.5.
 * Under the pinned worst case (the store read always fails), the real breaker
 * arithmetic (nextBreakerState): 3 failures, then interval × 2^level waits capped at
 * 60 min, then PARK after 24 h at the cap — no further attempts until a restart or a
 * config change. The attempt count settles; it does not grow with uptime.
 */
const replicatedStoreReconcilerRetry: SelfActionController = {
  id: 'replicated-store-reconciler',
  actionVerb: 'reconcile-retry',
  models: 'src/core/ReplicatedStoreReconciler.ts (noteFailure → nextBreakerState: backoff to 60 min, park after 24 h at the cap)',
  modelsPath: 'src/core/ReplicatedStoreReconciler.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The breaker is in memory; a restart is the documented operator lever to retry a parked store, and nothing in this controller causes a restart.' },
  boundK: 40,
  perTargetBoundK: 40,
  ticks: 600,
  tickMs: 10 * 60_000, // the default reconcile interval
  makeUnderPressure(f, sink) {
    const TARGET = 'knowledge';
    let state: { failures: number; level: number; capSince?: number } = { failures: 0, level: 0 };
    let waitUntil = 0;
    let parked = false;
    return {
      tick() {
        sink.considered += 1;
        const now = f.clock.nowMs();
        if (parked || now < waitUntil) return;
        sink.emit({ verb: 'reconcile-retry', target: TARGET });
        if (!f.targetAlwaysRejects()) { state = { failures: 0, level: 0 }; waitUntil = 0; return; }
        const next = nextBreakerState(state, now, RECONCILE_LIMITS.defaultIntervalMs);
        state = { failures: next.failures, level: next.level, capSince: next.capSince };
        if (next.waitUntil) waitUntil = next.waitUntil;
        if (next.park) parked = true;
      },
    };
  },
};

const interactiveLoginExpiredSwap: SelfActionController = {
  id: 'interactive-login-expired-swap',
  actionVerb: 'account-swap',
  models: 'src/core/InteractiveLoginExpiredRecovery.ts (decideLoginExpiredSwap: 10-min cooldown + 3-attempt cap per session)',
  modelsPath: 'src/core/InteractiveLoginExpiredRecovery.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The attempt budget is in memory; after a restart a stuck session needs a fresh 60-s dwell and is again capped at 3 attempts, and nothing in this controller causes a restart.' },
  boundK: INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS,
  perTargetBoundK: INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS,
  ticks: 60,
  tickMs: 5 * 60_000, // the monitor re-offers well inside every cooldown
  makeUnderPressure(f, sink) {
    const TARGET = 'stuck-topic-session';
    let attempts = 0;
    let lastAt: number | null = null;
    return {
      tick() {
        sink.considered += 1;
        const d = decideLoginExpiredSwap({ attempts, lastAttemptAtMs: lastAt, nowMs: f.clock.nowMs(),
          cooldownMs: INTERACTIVE_LOGIN_SWAP_COOLDOWN_MS, maxAttempts: INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS });
        if (d !== 'attempt') return;
        attempts += 1; lastAt = f.clock.nowMs();
        sink.emit({ verb: 'account-swap', target: TARGET });
        if (!f.targetAlwaysRejects()) { attempts = 0; } // a real move (never under the fixture)
      },
    };
  },
};

/**
 * device-limit-session-move — codex-device-limit-tripwire §4. A live interactive Codex session on
 * an account benched for a (suspected) device limit is moved to another Codex account. Under the
 * pinned fixture every move is refused, so the bench never clears its sessions. The REAL brake is
 * the same `decideLoginExpiredSwap` the mover calls: one attempt per 10-min cooldown, at most 3 per
 * session, then it stays put. Moves are also serialised one per 30 s per machine (not modelled:
 * a stricter bound on the burst, not on the total).
 */
const deviceLimitSessionMove: SelfActionController = {
  id: 'device-limit-session-move',
  actionVerb: 'account-swap',
  models: 'src/core/DeviceLimitSessionMover.ts (decideLoginExpiredSwap: 10-min cooldown + 3-attempt cap per session; 30-s serialisation)',
  modelsPath: 'src/core/DeviceLimitSessionMover.ts',
  restartPosture: { pressureSurvives: false, resetSafeReason: 'The attempt budget is in memory; after a restart a benched account only moves sessions again on a new bench, still capped at 3 attempts per session, and nothing in this controller causes a restart.' },
  boundK: INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS,
  perTargetBoundK: INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS,
  ticks: 60,
  tickMs: 5 * 60_000,
  makeUnderPressure(f, sink) {
    const TARGET = 'session-on-benched-account';
    let attempts = 0;
    let lastAt: number | null = null;
    return {
      tick() {
        sink.considered += 1;
        const d = decideLoginExpiredSwap({ attempts, lastAttemptAtMs: lastAt, nowMs: f.clock.nowMs(),
          cooldownMs: INTERACTIVE_LOGIN_SWAP_COOLDOWN_MS, maxAttempts: INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS });
        if (d !== 'attempt') return;
        attempts += 1; lastAt = f.clock.nowMs();
        sink.emit({ verb: 'account-swap', target: TARGET });
        if (!f.targetAlwaysRejects()) { attempts = 0; }
      },
    };
  },
};

/**
 * overload-shed — trustworthy-machine-load Part D (D1–D4). The real
 * OverloadShedPlanner under the pinned worst case: this machine's admission is
 * closed and enforced on every sample, forever; a healthy peer always has room;
 * and the peer NEVER claims a proposed topic (every move expires). Brakes, all in
 * the planner: one live move at a time (10 min entry TTL), 2 moves per hour, a
 * 30 min per-topic cooldown, MAX_ATTEMPTS_PER_TOPIC (2) per overload episode, and
 * at most MAX_REFUNDS_PER_TOPIC (2) refunds for proposals whose transfer never
 * started (the worst case modelled here). The episode never ends under pressure,
 * so the total settles at 4 × the topics (5 topics → 20 proposals) and the
 * per-topic count at 4, independent of the horizon. The reconciler (the actuator)
 * additionally initiates at most ONE transfer per topic per episode. The episode,
 * attempt and refund counts are durable, so a restart continues the same episode.
 */
function makeOverloadShedPlanner(f: PressureFixture, sink: ActionSink): { tick(): void } {
  let statePath = f.durableState.get('overload-shed-state-path') as string | undefined;
  if (!statePath) {
    statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'instar-overload-shed-model-')), 'state.json');
    f.durableState.set('overload-shed-state-path', statePath);
  }
  const topics = Array.from({ length: 5 }, (_, i) => ({ sessionKey: String(1001 + i), pinned: false }));
  const nowIso = () => new Date(f.clock.nowMs()).toISOString();
  const planner = new OverloadShedPlanner({
    config: () => ({ ...DEFAULT_OVERLOAD_SHED, enabled: true, dryRun: false }),
    selfMachineId: () => 'm-self',
    admission: () => ({ acceptingWork: false, enforced: true }),
    capacities: () => [
      { machineId: 'm-self', online: true, maxSessions: 10, activeSessionCount: 10, loadVerdict: 'saturated' },
      { machineId: 'm-peer', online: true, maxSessions: 100, activeSessionCount: 1, loadVerdict: 'ok',
        liveness: { state: 'live', evidenceAgeMs: 5_000, evidenceAt: nowIso(), source: 'direct' } },
    ] as MachineCapacity[],
    ownedTopics: () => topics,
    ownerOf: () => 'm-self', // the peer never claims: every proposed move expires
    // Worst case for the refund path: the transfer is never even started, so every
    // expiry is refundable — capped at MAX_REFUNDS_PER_TOPIC per topic per episode.
    statusOf: () => ({ status: 'active' }),
    placement: new PlacementExecutor(),
    statePath,
    now: () => f.clock.nowMs(),
  });
  let proposedSeen = 0; // per-process counter (the planner's counters are in memory)
  return {
    tick() {
      sink.considered += 1;
      planner.tick();
      const proposed = (planner.status() as { counters: { proposed: number } }).counters.proposed;
      const live = planner.overloadMoves()[0];
      if (proposed > proposedSeen && live) {
        proposedSeen = proposed;
        sink.emit({ verb: 'converge-overload-transfer', target: live.sessionKey });
      }
    },
  };
}

const overloadShed: SelfActionController = {
  id: 'overload-shed',
  actionVerb: 'converge-overload-transfer',
  models: 'src/core/OverloadShedPlanner.ts (OverloadShedPlanner.tick — one live move, 2/hour breaker, 30 min topic cooldown, 2 attempts + 2 never-started refunds per topic per durable overload episode)',
  modelsPath: 'src/core/OverloadShedPlanner.ts',
  boundK: 20,
  perTargetBoundK: 4,
  ticks: 4 * 60 * 16, // 16 hours of 15 s samples (enough for 20 proposals at 2/hour)
  tickMs: 15_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) { return makeOverloadShedPlanner(f, sink); },
  },
  makeUnderPressure(f, sink) { return makeOverloadShedPlanner(f, sink); },
};

/**
 * attention-lifecycle-pass — the hourly attention reconciliation pass
 * (src/messaging/TelegramAdapter.ts runAttentionLifecyclePass; spec
 * docs/specs/attention-lifecycle-close-on-cause.md §3.4): supersede duplicate
 * open rows → producer-verified clears → bounded expiry. Convergence shape:
 * every action moves a row to a TERMINAL state (DONE) the pass itself never
 * reopens, so under the pinned worst case — a backlog of duplicate and stale
 * rows nobody ever touches again — the total action count is exactly one
 * close per row that qualifies and the per-row count is 1; from the second
 * pass on, with no new rows, it closes zero. The brake is structural
 * (terminal state + idempotent re-read), not a counter. Drives the SAME pure
 * decision functions the adapter calls (planAttentionSupersessions,
 * decideAttentionExpiry), not a re-implementation.
 */
const attentionLifecyclePass: SelfActionController = {
  id: 'attention-lifecycle-pass',
  actionVerb: 'reap-stale-attention-row', // 'reap' detector token: a row is retired to DONE
  models: 'src/messaging/TelegramAdapter.ts (runAttentionLifecyclePass — supersede → verified clears → expiry; startAttentionLifecycleTimers hourly)',
  modelsPath: 'src/messaging/TelegramAdapter.ts',
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure(f, sink) {
      // The rows are durable (state/attention-items.json); a restart re-reads
      // them with their terminal statuses, so a closed row stays closed and the
      // pass finds nothing new. Modelled by rebuilding the controller over the
      // SAME durable row map.
      return makeAttentionLifecyclePassModel(f, sink, f.durableState);
    },
  },
  // 10 duplicate conditions × 3 rows: 2 superseded each (20) and the 10 keepers then expire as
  // stale automated rows (10); + 20 stale automated + 5 stale operator-asked = 55 closes, ever.
  boundK: 10 * 2 + 10 + 20 + 5,
  perTargetBoundK: 1,
  ticks: 72, // three days of hourly passes
  tickMs: 60 * 60 * 1000,
  makeUnderPressure(f, sink) {
    return makeAttentionLifecyclePassModel(f, sink, f.durableState);
  },
};

function makeAttentionLifecyclePassModel(f: PressureFixture, sink: ActionSink, durable: Map<string, unknown>): { tick(): void } {
  type Row = AttentionLifecycleItem & { status: string };
  const KEY = 'attention-lifecycle-pass:rows';
  const DAY = 86_400_000;
  // Virtual "now" starts far enough along that the seeded rows are already stale.
  const base = f.clock.nowMs() + 400 * DAY;
  if (!durable.has(KEY)) {
    const rows = new Map<string, Row>();
    const at = (daysAgo: number) => new Date(base - daysAgo * DAY).toISOString();
    for (let c = 0; c < 10; c++) {
      // Three timestamped duplicates of one condition (a legacy producer without a conditionKey).
      for (let d = 0; d < 3; d++) {
        const id = `held:${c}:${1_700_000_000_000 + c * 1000 + d}`;
        rows.set(id, { id, title: 'A reply is held', category: 'telegram-origin', sourceContext: 'origin', priority: 'NORMAL', status: 'OPEN', createdAt: at(30 - d), updatedAt: at(30 - d) });
      }
    }
    for (let i = 0; i < 20; i++) {
      const id = `rope-health-urgent:${i}:ep-1`;
      rows.set(id, { id, title: `rope ${i} down`, category: 'mesh', sourceContext: 'rope-health', priority: 'NORMAL', status: 'OPEN', createdAt: at(40), updatedAt: at(40) });
    }
    for (let i = 0; i < 5; i++) {
      const id = `agent:ask-${i}`;
      rows.set(id, { id, title: `Your call on thing ${i}?`, category: 'decision', sourceContext: 'agent', priority: 'NORMAL', status: 'OPEN', createdAt: at(60), updatedAt: at(60) });
    }
    // The floors: never acted on, however long the horizon.
    rows.set('sec-1', { id: 'sec-1', title: 'Rotate exposed GitHub access token', category: 'security', priority: 'HIGH', status: 'OPEN', createdAt: at(90), updatedAt: at(90) });
    rows.set('ack-1', { id: 'ack-1', title: 'operator is on it', category: 'general', sourceContext: 'x', priority: 'NORMAL', status: 'ACKNOWLEDGED', createdAt: at(90), updatedAt: at(90) });
    durable.set(KEY, rows);
  }
  const rows = durable.get(KEY) as Map<string, Row>;
  const cfg = resolveAttentionLifecycleConfig(undefined);
  const close = (row: Row) => {
    row.status = 'DONE';
    row.updatedAt = new Date(base + f.clock.nowMs()).toISOString();
    sink.emit({ verb: 'reap-stale-attention-row', target: row.id });
  };
  return {
    tick() {
      sink.considered += 1;
      const nowMs = base + f.clock.nowMs();
      // 1. supersede duplicates (the same pure planner the adapter uses)
      for (const plan of planAttentionSupersessions([...rows.values()])) {
        for (const dup of plan.close) close(rows.get(dup.id)!);
      }
      // 2. verified clears: the pinned worst case has NO producer that ever answers 'cleared'.
      // 3. expiry (the same pure decision the adapter uses); the fixture's first pass is live.
      for (const row of rows.values()) {
        if (row.status !== 'OPEN') continue;
        const d = decideAttentionExpiry(row, cfg, nowMs);
        if (d.expire) close(row);
      }
    },
  };
}


/**
 * throwaway-expiry-teardown — test-agent-leak-guard (docs/specs/test-agent-leak-guard.md).
 * An expired throwaway's server/lifeline runs the teardown at every start; if
 * its own launchd job cannot be unloaded, launchd KeepAlive restarts it, so the
 * teardown is re-attempted on every restart. Drives the REAL
 * teardownExpiredThrowaway under the "unload always fails" pressure: each tick
 * is one launchd restart. The attempt counter lives in the on-disk marker
 * (survives restart), and after MAX_TEARDOWN_ATTEMPTS the outcome is
 * `quarantined` (terminal) — no further unload attempts, horizon-independent.
 */
function makeThrowawayTeardownLoop(f: PressureFixture, sink: ActionSink): { tick(): void } {
  let dir = f.durableState.get('throwaway-teardown-dir') as string | undefined;
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-action-throwaway-'));
    fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName: 'sa', throwawayAgent: { createdAt: 'x', expiresAt: '2000-01-01T00:00:00Z' } }));
    f.durableState.set('throwaway-teardown-dir', dir);
  }
  const projectDir = dir;
  return {
    tick() {
      sink.considered += 1; // one launchd restart considered per tick
      checkThrowawayExpiry('sa', projectDir, {
        platform: 'darwin',
        homes: [path.join(projectDir, 'nohome')],
        uid: 501,
        run: (_cmd, args) => {
          if (args[0] === 'print') return `\tworking directory = ${projectDir}\n`;
          if (args[0] === 'bootout') {
            sink.emit({ verb: 'kill', target: 'ai.instar.sa' });
            if (f.targetAlwaysRejects()) throw new Error('bootout refused');
          }
          return '';
        },
      });
    },
  };
}

/**
 * local-verify-interrupted-resume — a server stop that kills a running PR verify
 * (2026-10-26: the lifeline's drift restart killed PR 2350's run four times, each
 * time un-counted and re-queued behind a fresh `main` verify). Modelled: every tick
 * is a server stop + boot under which the interrupted PR is restored FIRST
 * (`resumeFirst`, consumed on its single start — never two jumps per interruption),
 * its attempt stays counted (`attempts` never decremented), and the starved signal
 * fires ONCE per entry when `interruptions` reaches INTERRUPTION_LIMITS.starvedAfter
 * (`starvedRaised` persisted) — horizon-independent: 48 restarts ⇒ at most one
 * notify per entry (2 entries ⇒ boundK 2), not one per restart.
 */
const localVerifyInterruptedResume: SelfActionController = {
  id: 'local-verify-interrupted-resume',
  actionVerb: 'notify-starved-verify-retry',
  models: 'src/localVerify/LocalVerifyService.ts (shutdown/restoreQueue → interruptions + resumeFirst; checkStarved/raiseStarvedIfDue → decideStarved(interrupted); pump → decideStart(resumeFirst))',
  modelsPath: 'src/localVerify/LocalVerifyService.ts',
  boundK: 2,
  perTargetBoundK: 1,
  ticks: 48,
  tickMs: 5 * 60_000,
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeInterruptedResume(f, sink),
  },
  makeUnderPressure(f, sink) { return makeInterruptedResume(f, sink); },
};

/** Entries live in `durableState` (queue.json): a restart is one more interruption, never a reset. */
function makeInterruptedResume(f: PressureFixture, sink: ActionSink): { tick(): void } {
  type E = { pr: number; attempts: number; errorRetries: number; firstQueuedAt: number; starvedRaised: boolean; interruptions: number; resumeFirst?: true; running: boolean };
  const key = 'local-verify-interrupted-resume:queue';
  const t0 = f.clock.nowMs();
  let queue = (f.durableState.get(key) as E[] | undefined)
    ?? [301, 302].map((pr): E => ({ pr, attempts: 0, errorRetries: 0, firstQueuedAt: t0, starvedRaised: false, interruptions: 0, running: false }));
  f.durableState.set(key, queue);
  const main: { kind: 'main'; notBefore?: number; pr?: undefined } = { kind: 'main' };
  return {
    tick() {
      sink.considered += 1;
      const now = f.clock.nowMs();
      // 1. The server stops: the running entry is interrupted (shutdown): counted, marked, re-queued first.
      const ran = queue.find((e) => e.running);
      if (ran) {
        ran.running = false;
        ran.interruptions += 1;
        ran.resumeFirst = true;
        queue = [ran, ...queue.filter((e) => e !== ran)];
        f.durableState.set(key, queue);
      }
      // 2. Boot: restored entries are checked for starvation before anything starts.
      for (const e of queue) {
        const d = decideStarved(e, now);
        if (!d.raise) continue;
        e.starvedRaised = true;
        if (d.reason !== 'interrupted' && e.interruptions >= 2) throw new Error('interruption threshold should raise with reason interrupted');
        sink.emit({ verb: 'notify-starved-verify-retry', target: String(e.pr) });
      }
      // 3. The boot-time `main` verify is queued; the interrupted PR must still start first.
      const q: Array<E | typeof main> = [main, ...queue];
      const d = decideStart({ foreignHolders: 0, queue: q, now, fairShare: { mainHealthy: false, oldestUnverifiedMainAt: now, lastStartWasMain: false } });
      if (d.kind !== 'start') return;
      const picked = q[d.index];
      if (ran && picked !== ran) throw new Error(`interrupted PR ${ran.pr} did not resume first (picked ${picked.pr ?? 'main'})`);
      if (picked.pr === undefined) return;
      // The start consumes resumeFirst (one jump per interruption) and counts the attempt.
      if (picked.resumeFirst !== true && ran === picked) throw new Error('resumeFirst was not set on the interrupted entry');
      delete picked.resumeFirst;
      picked.attempts += 1;
      picked.running = true;
      const prior = (f.durableState.get(key + ':attempts') as Map<number, number> | undefined) ?? new Map<number, number>();
      if ((prior.get(picked.pr) ?? 0) >= picked.attempts) throw new Error(`attempts went backwards for pr ${picked.pr} (an interrupted run was un-counted)`);
      prior.set(picked.pr, picked.attempts);
      f.durableState.set(key + ':attempts', prior);
    },
  };
}

const throwawayExpiryTeardown: SelfActionController = {
  id: 'throwaway-expiry-teardown',
  actionVerb: 'kill',
  models: 'src/core/ThrowawayAgentGuard.ts (teardownExpiredThrowaway — durable attempt counter, quarantine after MAX_TEARDOWN_ATTEMPTS)',
  modelsPath: 'src/core/ThrowawayAgentGuard.ts',
  restartPosture: {
    pressureSurvives: true,
    restartUnderPressure: (f, sink) => makeThrowawayTeardownLoop(f, sink),
  },
  boundK: MAX_TEARDOWN_ATTEMPTS,
  perTargetBoundK: MAX_TEARDOWN_ATTEMPTS,
  ticks: 40,
  tickMs: 10_000, // launchd ThrottleInterval
  eternalSentinel: undefined,
  makeUnderPressure: (f, sink) => makeThrowawayTeardownLoop(f, sink),
};

/** One failed provider result can cause at most three audited calls; SQLite
 * persists call_count and the 24-hour expiry across worker restarts. */
const jobSupervisionProviderRetry: SelfActionController = {
  id: 'job-supervision-provider-retry',
  actionVerb: 'retry-provider-call',
  models: 'src/scheduler/JobSupervisionWorker.ts (per-result provider retry via JobSupervisionStore.call_count)',
  modelsPath: 'src/scheduler/JobSupervisionWorker.ts',
  boundK: 3, perTargetBoundK: 3, ticks: 30, tickMs: 60 * 60_000,
  restartPosture: { pressureSurvives: true, restartUnderPressure: (f, sink) => jobSupervisionRetryModel(f, sink) },
  makeUnderPressure: (f, sink) => jobSupervisionRetryModel(f, sink),
};

function jobSupervisionRetryModel(f: PressureFixture, sink: ActionSink): { tick(): void } {
  return { tick() {
    sink.considered++;
    if (!f.targetAlwaysRejects()) return;
    const count = (f.durableState.get('supervision-call-count') as number | undefined) ?? 0;
    if (count >= 3) return;
    f.durableState.set('supervision-call-count', count + 1);
    sink.emit({ verb: 'retry-provider-call', target: 'one-result' });
  } };
}

/** A missing run-history row gets one unchecked recovery record. Later ticks
 * see that row by unique run_id and cannot insert another. */
const jobSupervisionCensusRepair: SelfActionController = {
  id: 'job-supervision-census-repair',
  actionVerb: 'retry-census-repair',
  models: 'src/scheduler/JobSupervisionStore.ts (reconcileHistory unique run_id and unchecked recovery)',
  modelsPath: 'src/scheduler/JobSupervisionStore.ts',
  boundK: 1, perTargetBoundK: 1, ticks: 60, tickMs: 30_000,
  restartPosture: { pressureSurvives: true, restartUnderPressure: (f, sink) => jobSupervisionCensusModel(f, sink) },
  makeUnderPressure: (f, sink) => jobSupervisionCensusModel(f, sink),
};

function jobSupervisionCensusModel(f: PressureFixture, sink: ActionSink): { tick(): void } {
  return { tick() {
    sink.considered++;
    if (!f.targetAlwaysRejects() || f.durableState.get('supervision-census-recovered')) return;
    f.durableState.set('supervision-census-recovered', true);
    sink.emit({ verb: 'retry-census-repair', target: 'one-run-id' });
  } };
}

/**
 * Session-pool stage promotion (CMT-1117) under a regression that shows ONLY at
 * the target stage: every hourly runner pass records green while the pool sits
 * at 'dark' and red while it sits at 'shadow'. Before the fix this flapped
 * dark<->shadow once a minute (69 promotions in a day). Now a promotion needs a
 * prior-stage green newer than the target's latest red, and stops after
 * MAX_TARGET_REDS_PER_COMMIT reds at the target per build. Runs the REAL
 * StageAdvancer + SessionPoolRolloutDriver; results and stage live in durable
 * state (the real ones are a file and config), so they survive restart.
 */
const sessionPoolStagePromotion: SelfActionController = {
  id: 'session-pool-stage-promotion',
  actionVerb: 'retry-stage-promotion',
  models: 'src/core/SessionPoolRolloutDriver.ts (auto-climb tick) over src/core/StageAdvancer.ts (advanceTo / reconcile)',
  modelsPath: 'src/core/SessionPoolRolloutDriver.ts',
  boundK: MAX_TARGET_REDS_PER_COMMIT,
  perTargetBoundK: MAX_TARGET_REDS_PER_COMMIT,
  ticks: 600,
  tickMs: 60_000,
  restartPosture: { pressureSurvives: true, restartUnderPressure: (f, sink) => sessionPoolStagePromotionModel(f, sink) },
  makeUnderPressure: (f, sink) => sessionPoolStagePromotionModel(f, sink),
};

function sessionPoolStagePromotionModel(f: PressureFixture, sink: ActionSink): { tick(): void } {
  const ROWS = 'session-pool-stage:rows';
  const STAGE = 'session-pool-stage:stage';
  const SHA = 'build-under-pressure';
  const rows = (): StageE2EResult[] => (f.durableState.get(ROWS) as StageE2EResult[] | undefined) ?? [];
  const store = {
    all: () => rows(),
    getLatestForStage: (idx: number) => { let l: StageE2EResult | null = null; for (const r of rows()) if (r.stage === idx) l = r; return l; },
    verify: () => true,
  } as unknown as SessionPoolE2EResultStore;
  const readStage = (): SessionPoolStage => (f.durableState.get(STAGE) as SessionPoolStage | undefined) ?? 'dark';
  const driver = new SessionPoolRolloutDriver({
    advancer: new StageAdvancer({
      resultStore: store,
      currentCommitSha: () => SHA,
      readStage,
      writeStageConfig: (st) => f.durableState.set(STAGE, st),
    }),
    enabled: () => true,
    targetCeiling: () => 'shadow',
  });
  return {
    tick() {
      sink.considered += 1;
      // The hourly runner records against the stage running now (every 60th tick).
      if (Math.round(f.clock.nowMs() / 60_000) % 60 === 0) {
        const stage = readStage();
        const result: 'green' | 'red' = stage === 'dark' ? 'green' : 'red';
        f.durableState.set(ROWS, [...rows(), { stage: stage === 'dark' ? 0 : 1, result, commitSha: SHA, ranAt: new Date(f.clock.nowMs()).toISOString(), evidenceRef: 'model', signature: 'model' }]);
      }
      const r = driver.tick();
      if (r.advancedTo) sink.emit({ verb: 'retry-stage-promotion', target: r.advancedTo });
    },
  };
}

export const SELF_ACTION_CONTROLLERS: SelfActionController[] = [
  desktopRelockGuardReplacement,
  desktopLockedHelperRespawn,
  sessionPoolStagePromotion,
  jobSupervisionProviderRetry,
  jobSupervisionCensusRepair,
  throwawayExpiryTeardown,
  localVerifyInterruptedResume,
  localVerifyFailedFileDiagnosis,
  attentionLifecyclePass,
  localVerifyFlakeRerun,
  localVerifyMergeHandoff,
  localVerifyMainFairShare,
  localVerifyErrorRerun,
  localVerifyCapacityRequeue,
  localVerifyMainSchedule,
  localVerifyMainDebounce,
  localVerifyStatusPost,
  localVerifyStatusPassBackoff,
  systemTopicAdoption,
  lifelineIngressRestartSignal,
  lifelineSecretRefusalRedrive,
  overloadAdmissionSelfHelp,
  overloadShed,
  feedbackTriageTick,
  queuePaceExtraRun,
  jobScriptTriageEpisode,
  jobScriptTriageBackup,
  feedbackTriageActionList,
  feedbackTriageSelfHealProbe,
  passkeyRevokeOutbox,
  telegramOriginSourcePoller,
  originStoreWorkerRestart,
  telegramOriginOwnedDetectorCanary,
  telegramOriginNativeModelCanary,
  telegramOriginForwardLadder,
  telegramBrowserCanaryRecovery,
  identityReannounce,
  windowRunCadenceDeliveryRedrive,
  windowLifecycleIssueEscalation,
  subscriptionReloginRedrive,
  standDownMaintenance,
  evolutionActionExpirySweep,
  spendReconSweep,
  spendDoorDarkBrakes,
  spendFallbackSpike,
  spendCapApproach,
  proactiveSwapMonitor,
  ageKillBackoff,
  codexArmSessionSweep,
  promiseBeaconNotify,
  livenessHeartbeat,
  promiseBeaconInternalCadence,
  externalHogKillBreaker,
  meteredReserveExpirySweep,
  jobFailureAlertDelivery,
  checkInReminderPass,
  undatedActionResurfacer,
  spendStalePriceAlert,
  ownerDarkNotice,
  duplicateConvergeWrite,
  burnAlertTerminalDelivery,
  stopGateAuthorityProbe,
  correctionClassReviewOutcomes,
  feedbackGeneratedDefaultsHeal,
  feedbackExecute,
  mutualSshRepairSweep,
  followMeEnrollmentConsumer,
  agentIdentityAdoption,
  agentIdentityCoherenceDetector,
  a2aPeerDarkRaise,
  threadlineConnectEnableRestart,
  interactiveLoginExpiredSwap,
  deviceLimitSessionMove,
  replicatedStoreReconcilerRetry,
];
