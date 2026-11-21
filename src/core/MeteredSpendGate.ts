/**
 * MeteredSpendGate — the O(1), never-cached, FAIL-CLOSED money gate of the
 * Routing Control Room (docs/specs/routing-control-room-spend-alerts.md,
 * Increment B, Layer 3).
 *
 * Before a metered call: read committed FRESH from the MeteredSpendLedger, read
 * the door's CANONICAL VALIDATED price (never the observed cache, never the
 * overlay), compute the worst-case reserve at BASE price (no subsidy/credit),
 * and refuse when `committed + estCost > cap` (strict `>`). FAIL CLOSED on
 * EVERY uncertainty — that is the entire safety posture:
 *   not-live · frozen · no-cap-slice · lease-liveness-unconfirmed ·
 *   unbounded-reservation · unknown-price · implausible-price ·
 *   stale-price-fail-closed · invalid-cap · cap-exceeded · ledger-error
 *
 * Authority shape (signal-vs-authority): deterministic ARITHMETIC authority at
 * the metered admission point only. A refusal is a swap-tail ADVANCE for the
 * router (the chain falls to a free door) — never a chain kill (LF-A2).
 *
 * Structural exclusions (unit-tested):
 *  - reads NO `feature_metrics`, NO provider-report store, NO observed price
 *    cache, NO subsidy/credit input — only the ledger, the canonical manifest
 *    meta/points, and the PIN caps store.
 *
 * Wiring status (FD-11, honest): the metered dispatch that CALLS this gate is
 * out-of-scope in-flight S4 work; the gate is fully unit-testable against a
 * stub dispatch, and go-live remains refused until the FD-11 release-gate
 * preconditions are met. Nothing in Increment B routes real money.
 */

import { CapExceededError, CallIdConflictError, E1PassLimitError } from './MeteredSpendLedger.js';
import type { MeteredSpendLedger, ReserveHandle, AdmitCaps, ReservationView } from './MeteredSpendLedger.js';
import type { RoutingPriceAuthority } from './routingPriceAuthority.js';
import { pricePointId } from './routingPriceAuthority.js';
import type { RoutingSpendCapsStore, CapsStoreFile, KeyCapsRecord, MeteredCallerId } from './RoutingSpendCapsStore.js';
import { METERED_CALLER_IDS, periodTimeZoneOf } from './RoutingSpendCapsStore.js';
import { PROBE_DOOR } from './moneyLayerProbe.js';
import { DEFAULT_FRESHNESS_SLA_DAYS } from './routingPriceAuthority.js';

/**
 * Per-provider price plausibility floors, USD per MILLION tokens — CODE-DEFINED
 * constants, deliberately not config (A-M5/S-F1: a Bearer-writable surface must
 * never influence a gate-consumed price value). A canonical point BELOW its
 * provider's floor is treated as a typo → `implausible-price` → fail closed.
 */
export const PROVIDER_PRICE_FLOORS_PER_MTOK: Readonly<Record<string, { inPerMtok: number; outPerMtok: number }>> = {
  google: { inPerMtok: 0.01, outPerMtok: 0.01 },
  openrouter: { inPerMtok: 0.01, outPerMtok: 0.01 },
  groq: { inPerMtok: 0.01, outPerMtok: 0.01 },
};

/** How stale the metered-lease self-confirmation may be before the holder self-fences (N-2). MUST stay strictly shorter than the mesh-death threshold. */
export const LEASE_LIVENESS_WINDOW_MS = 60_000;

export type MoneyGateRefusalReason =
  | 'not-live'
  | 'frozen'
  | 'no-cap-slice'
  | 'lease-liveness-unconfirmed'
  | 'unbounded-reservation'
  | 'unknown-price'
  | 'implausible-price'
  | 'stale-price-fail-closed'
  | 'invalid-cap'
  | 'cap-exceeded'
  | 'ledger-error'
  // gemini-payg §5 "Refusal reasons" — the 13 new reasons.
  | 'not-allowlisted'
  | 'armed-pending-proof'
  | 'per-call-ceiling'
  | 'outside-verified-tier'
  | 'token-count-unavailable'
  | 'prompt-contains-live-secret'
  | 'provisional-ceiling'
  | 'e1-pass-limit'
  | 'key-generation-mismatch'
  | 'request-too-large'
  | 'callid-conflict'
  | 'e2-share-exceeded'
  | 'reserves-outstanding';

/** Caller-side postures (not gate reasons) that share the status table (§5). */
export type MeteredCallerPosture = 'holder-unreachable' | 'peer-version' | 'lease-liveness-unconfirmed';

/** The period a 402 refusal names. */
export type RefusalPeriod = 'day' | 'month' | 'call' | 'provisional' | 'lifetime';

/** Structured facts a refusal carries (402s: period + money figures + reset; 409 reserves-outstanding: retryAfterSec). */
export interface RefusalFacts {
  period?: RefusalPeriod;
  settledUsd?: number;
  outstandingUsd?: number;
  capUsd?: number;
  resetsAt?: string | null;
  retryAfterSec?: number;
}

/** A cap/uncertainty refusal — the router treats it as a swap-tail ADVANCE, never a chain kill. */
export class MoneyGateRefusal extends Error {
  constructor(
    public reason: MoneyGateRefusalReason,
    public detail: string,
    public keyRef?: string,
    public door?: string,
    public facts?: RefusalFacts,
  ) {
    super(`money gate refused (${reason}): ${detail}`);
    this.name = 'MoneyGateRefusal';
  }

  /** The wire form — what a forwarded call carries back unchanged (§5: "survives forwarding unchanged"). */
  toWire(): MoneyGateRefusalWire {
    return {
      refused: true,
      reason: this.reason,
      status: refusalHttpStatus(this.reason),
      message: refusalPlainMessage(this.reason),
      detail: this.detail,
      ...(this.keyRef ? { keyRef: this.keyRef } : {}),
      ...(this.door ? { door: this.door } : {}),
      ...(this.facts ?? {}),
    };
  }

  /** Rebuild a refusal from its wire form. An unknown reason is refused (fail closed: not a pass). */
  static fromWire(w: unknown): MoneyGateRefusal {
    const o = (w ?? {}) as Partial<MoneyGateRefusalWire>;
    const reason = typeof o.reason === 'string' && (ALL_REFUSAL_REASONS as readonly string[]).includes(o.reason) ? (o.reason as MoneyGateRefusalReason) : 'ledger-error';
    const facts: RefusalFacts = {};
    if (o.period) facts.period = o.period;
    if (typeof o.settledUsd === 'number') facts.settledUsd = o.settledUsd;
    if (typeof o.outstandingUsd === 'number') facts.outstandingUsd = o.outstandingUsd;
    if (typeof o.capUsd === 'number') facts.capUsd = o.capUsd;
    if (o.resetsAt !== undefined) facts.resetsAt = o.resetsAt;
    if (typeof o.retryAfterSec === 'number') facts.retryAfterSec = o.retryAfterSec;
    return new MoneyGateRefusal(
      reason,
      typeof o.detail === 'string' ? o.detail : `unrecognised refusal ${String(o.reason)}`,
      typeof o.keyRef === 'string' ? o.keyRef : undefined,
      typeof o.door === 'string' ? o.door : undefined,
      Object.keys(facts).length ? facts : undefined,
    );
  }
}

export interface MoneyGateRefusalWire extends RefusalFacts {
  refused: true;
  reason: MoneyGateRefusalReason;
  status: number;
  message: string;
  detail: string;
  keyRef?: string;
  door?: string;
}

export const ALL_REFUSAL_REASONS: readonly MoneyGateRefusalReason[] = [
  'not-live', 'frozen', 'no-cap-slice', 'lease-liveness-unconfirmed', 'unbounded-reservation', 'unknown-price',
  'implausible-price', 'stale-price-fail-closed', 'invalid-cap', 'cap-exceeded', 'ledger-error',
  'not-allowlisted', 'armed-pending-proof', 'per-call-ceiling', 'outside-verified-tier', 'token-count-unavailable',
  'prompt-contains-live-secret', 'provisional-ceiling', 'e1-pass-limit', 'key-generation-mismatch',
  'request-too-large', 'callid-conflict', 'e2-share-exceeded', 'reserves-outstanding',
];

/**
 * HTTP status per refusal reason / caller posture (gemini-payg §5 status
 * table). Reasons the table does not name keep a status that matches their
 * class: price/shape problems 422, locked states 423, infrastructure 503.
 */
const REFUSAL_STATUS: Readonly<Record<MoneyGateRefusalReason | MeteredCallerPosture, number>> = {
  'cap-exceeded': 402,
  'e2-share-exceeded': 402,
  'per-call-ceiling': 402,
  'provisional-ceiling': 402,
  'outside-verified-tier': 422,
  'unknown-price': 422,
  'request-too-large': 422,
  'prompt-contains-live-secret': 422,
  'implausible-price': 422,
  'stale-price-fail-closed': 422,
  'unbounded-reservation': 422,
  'reserves-outstanding': 409,
  'callid-conflict': 409,
  'frozen': 423,
  'not-live': 423,
  'armed-pending-proof': 423,
  'not-allowlisted': 403,
  'peer-version': 503,
  'key-generation-mismatch': 503,
  'e1-pass-limit': 429,
  'token-count-unavailable': 503,
  'holder-unreachable': 503,
  'lease-liveness-unconfirmed': 503,
  'no-cap-slice': 503,
  'invalid-cap': 503,
  'ledger-error': 503,
};

/** Plain-language message per reason (no ids, no internals — operator-facing wording). */
const REFUSAL_MESSAGE: Readonly<Record<MoneyGateRefusalReason | MeteredCallerPosture, string>> = {
  'cap-exceeded': 'This call would go over the spending limit for this period, so it was not made.',
  'e2-share-exceeded': 'Second opinions have used their share of the spending limit for this period, so this one was not made.',
  'per-call-ceiling': 'This single call would cost more than the most one call is allowed to cost, so it was not made.',
  'provisional-ceiling': 'Too many recent calls ended without a clear bill, so paid calls are paused until the operator reviews it or the month resets.',
  'outside-verified-tier': 'This request is larger than the size the price has been checked for, so it was not made.',
  'unknown-price': 'There is no checked price for this model, so the call was not made.',
  'request-too-large': 'This request is too large to send, so it was not made.',
  'prompt-contains-live-secret': 'The request contained a live password or key, so it was not sent.',
  'implausible-price': 'The recorded price for this model looks wrong, so the call was not made.',
  'stale-price-fail-closed': 'The recorded price for this model is out of date, so the call was not made.',
  'unbounded-reservation': 'The request had no limit on how much it could cost, so it was not made.',
  'reserves-outstanding': 'Other calls are still finishing and holding part of the limit. Try again in a moment.',
  'callid-conflict': 'This call id was already used for a different request, so it was not made.',
  'frozen': 'Paid calls on this key are stopped (frozen), so the call was not made.',
  'not-live': 'Paid calls are not switched on here, so the call was not made.',
  'armed-pending-proof': 'This paid door is set up but its one-time proof check has not passed yet, so ordinary calls wait.',
  'not-allowlisted': 'This kind of call is not allowed to use the paid door, so it was not made.',
  'peer-version': 'The machine that holds the paid door runs a different version, so the call was not made.',
  'key-generation-mismatch': 'The stored key is not the one that was approved, so the call was not made.',
  'e1-pass-limit': 'This review round already used its paid pass, so it was not repeated.',
  'token-count-unavailable': 'The request size could not be measured, so the call was not made.',
  'holder-unreachable': 'The machine that holds the paid door could not be reached, so the call was not made.',
  'lease-liveness-unconfirmed': 'This machine could not confirm it still holds the paid door, so the call was not made.',
  'no-cap-slice': 'This machine does not hold the paid door, so the call was not made here.',
  'invalid-cap': 'No valid spending limit is set for this key, so the call was not made.',
  'ledger-error': 'The spending record could not be written, so the call was not made.',
};

export function refusalHttpStatus(reason: MoneyGateRefusalReason | MeteredCallerPosture): number {
  return REFUSAL_STATUS[reason] ?? 503;
}

export function refusalPlainMessage(reason: MoneyGateRefusalReason | MeteredCallerPosture): string {
  return REFUSAL_MESSAGE[reason] ?? 'The paid call was not made.';
}

// ── Release-proof marker (gemini-payg §8) ───────────────────────────

const PROOF_MARKERS = new WeakSet<object>();

/**
 * The proof marker that admits the single `release-proof` call while a door is
 * `armed-pending-proof`. It is an in-process object registered in a module
 * WeakSet, so it cannot be constructed from request input (JSON never yields a
 * registered object). Minting is reserved for the release-proof recorder
 * (slice E); nothing else in the codebase may call `mintReleaseProofMarker`.
 */
export interface ReleaseProofMarker {
  readonly door: string;
  readonly intentHash: string;
}

export function mintReleaseProofMarker(door: string, intentHash: string): ReleaseProofMarker {
  const m = Object.freeze({ door, intentHash });
  PROOF_MARKERS.add(m);
  return m;
}

export function isReleaseProofMarker(v: unknown, door: string): v is ReleaseProofMarker {
  return typeof v === 'object' && v !== null && PROOF_MARKERS.has(v) && (v as ReleaseProofMarker).door === door;
}

export interface AdmitRequest {
  door: string;
  modelId: string;
  /** Prompt tokens (estimated or counted). Cached tokens reserve as FULL input (FD-19) — no cached discount at reserve time. */
  inputTokens: number;
  /**
   * REQUIRED bounded output ceiling — the metered request MUST set max_tokens (A2-4).
   * Carries output PLUS thinking, because the gate prices this field alone (§5).
   */
  maxOutputTokens: number | undefined;
  /** REQUIRED attribution component (gemini-payg §2). */
  component: string;
  /** REQUIRED caller (closed set). Missing ⇒ `not-allowlisted`. */
  caller: MeteredCallerId;
  /** Idempotency id: a resubmission returns the existing call's state (dedupe is step 0). */
  callId?: string;
  /** Digest of the exact request; same callId + different digest ⇒ `callid-conflict`. */
  requestSha256?: string;
  /** `<specPath>@<sha8>#<round>` for E1 rows. */
  run?: string;
  /** True only when `inputTokens` came from the provider's countTokens on the exact request. */
  inputTokensCounted?: boolean;
  /** The price point the caller expects (e.g. its tier preview); a mismatch refuses `outside-verified-tier`. */
  tierPointId?: string;
  /** E1 pass slot: required for caller `spec-review`. */
  e1Pass?: { specSha256: string; round: number };
}

export interface AdmitResult {
  reserveId: string;
  keyRef: string;
  reserveUsd: number;
  /** The booking price actually used (canonical base or conservative-max under stale policy). */
  bookedInPerMtok: number;
  bookedOutPerMtok: number;
  committedLifetimeUsd: number;
  committedDayUsd: number;
  committedMonthUsd: number;
  /** The selected price point — stored on the reservation; settle uses it. */
  pricePointId: string | null;
  /** True when this is an existing call returned by callId dedupe. */
  deduped?: boolean;
  state?: ReservationView['state'];
}

/**
 * Caller admission (gemini-payg §2 order steps 3–4): caller membership (and E3
 * component membership), then release state. Shared by the caller-facing entry
 * (before any key use) and the gate's in-lock policy re-read. Returns null when
 * the caller may proceed.
 */
export function callerAdmissionRefusal(
  file: CapsStoreFile,
  req: Pick<AdmitRequest, 'door' | 'caller' | 'component' | 'e1Pass'>,
  proofMarker: unknown,
): MoneyGateRefusal | null {
  const keyRef = file.goLive[req.door]?.keyRef;
  const deny = (detail: string) => new MoneyGateRefusal('not-allowlisted', detail, keyRef, req.door);
  const caller = req.caller as string | undefined;
  if (!caller || !(METERED_CALLER_IDS as readonly string[]).includes(caller)) {
    return deny(`a metered call must name its caller from the closed set (got ${caller ? `'${caller}'` : 'none'})`);
  }
  if (typeof req.component !== 'string' || !req.component.trim()) return deny('a metered call must name its attribution component');
  if (caller === 'probe') return deny("the 'probe' caller is reserved for the cap-gate probe, which never uses the caller-facing entry");
  const policy = file.doorPolicy?.[req.door];
  if (!policy) return deny(`door '${req.door}' has no caller policy — deny by default`);
  if (caller === 'release-proof') {
    if (!isReleaseProofMarker(proofMarker, req.door)) return deny('a release-proof call needs the proof marker only the release-proof recorder can stamp');
    if (policy.releaseState !== 'armed-pending-proof') return deny('the release proof is already recorded; the release-proof caller is closed');
    return null;
  }
  if (!policy.meteredCallers.callers.includes(caller as MeteredCallerId)) return deny(`caller '${caller}' is not enabled on door '${req.door}'`);
  if (caller === 'nature-routing' && !policy.meteredCallers.e3Components.includes(req.component)) {
    return deny(`component '${req.component}' is not on door '${req.door}'s nature-routing list`);
  }
  if (caller === 'spec-review' && (!req.e1Pass || typeof req.e1Pass.specSha256 !== 'string' || !Number.isInteger(req.e1Pass.round))) {
    return deny('a spec-review call must carry its (specSha256, round) pass key');
  }
  if (policy.releaseState === 'armed-pending-proof') {
    return new MoneyGateRefusal('armed-pending-proof', `door '${req.door}' is armed but its release proof has not passed — only the proof call is admitted`, keyRef, req.door);
  }
  return null;
}

/**
 * A callId resubmission must be the SAME call: same door, a request digest on
 * both sides, and the same digest (§5 step 6). Returns the refusal, or null
 * when it really is the existing call. A deduped result is the existing call's
 * STATE — never permission to send again.
 */
export function callIdConflict(req: Pick<AdmitRequest, 'callId' | 'door' | 'requestSha256'>, existing: ReservationView): MoneyGateRefusal | null {
  if (existing.door !== req.door || !req.requestSha256 || !existing.requestSha256 || req.requestSha256 !== existing.requestSha256) {
    return new MoneyGateRefusal('callid-conflict', `callId '${req.callId}' is already bound to a different request (or the resubmission carries no matching digest)`, existing.keyRef, req.door);
  }
  return null;
}

/** A positive cap value, or undefined when absent. Throws `invalid-cap` semantics via the caller. */
function capsValidity(keyCaps: KeyCapsRecord | undefined): { ok: true; lifetime?: number; monthly?: number; daily: number } | { ok: false } {
  if (!keyCaps) return { ok: false };
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const daily = keyCaps.dailyCapUsd;
  if (!pos(daily)) return { ok: false };
  const lifetime = keyCaps.lifetimeCapUsd;
  const monthly = keyCaps.monthlyCapUsd;
  // gemini-payg §5: a monthly-only record is valid; whichever cap is present must be positive.
  if (lifetime === undefined && monthly === undefined) return { ok: false };
  if (lifetime !== undefined && !pos(lifetime)) return { ok: false };
  if (monthly !== undefined && !pos(monthly)) return { ok: false };
  return { ok: true, ...(lifetime !== undefined ? { lifetime } : {}), ...(monthly !== undefined ? { monthly } : {}), daily };
}

export interface MeteredSpendGateOptions {
  ledger: MeteredSpendLedger;
  prices: RoutingPriceAuthority;
  capsStore: RoutingSpendCapsStore;
  /** This machine's id — compared against the go-live designation (FD-13). */
  machineId: string;
  /**
   * POSITIVE re-confirmation of this machine's metered-lease designation against
   * the pool: ms since the last successful confirmation, or null when never/failed.
   * A single-machine agent trivially self-confirms (return 0).
   */
  leaseConfirmedAgoMs: () => number | null;
  /**
   * OPTIONAL alert observer (Increment C — signal-only): fired AFTER a
   * successful admit (with post-admit committed + the caps, for the
   * cap-approach thresholds) and on a cap-exceeded refusal (for the
   * money-critical cap-hit alert). Throw-swallowed — an observer failure can
   * never disturb the admit/refuse path (unit-pinned).
   */
  onGateEvent?: (ev: import('./SpendAlertEmitters.js').GateEvent) => void;
  now?: () => number;
}

export class MeteredSpendGate {
  private readonly d: MeteredSpendGateOptions;
  private readonly now: () => number;

  constructor(opts: MeteredSpendGateOptions) {
    this.d = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Admit-or-refuse a metered call, booking the worst-case reserve on admit.
   * Every uncertainty throws MoneyGateRefusal (fail closed).
   *
   * `proofMarker` is a SEPARATE argument, never a request field: request input
   * cannot set it (gemini-payg §8). The cap-gate probe calls this directly with
   * none and on a door with no policy, so its path is unchanged.
   */
  async admit(req: AdmitRequest, proofMarker?: ReleaseProofMarker): Promise<AdmitResult> {
    // 0) callId dedupe FIRST: an admitted call is returned, never refused by a cap,
    // freeze or disabled caller (§5 step 6). The in-lock dedupe closes the race.
    if (req.callId) {
      const existing = this.d.ledger.lookupCall(req.callId);
      if (existing) return this.dedupeResult(req, existing);
    }
    // 1) Go-live: deny-by-default (not-live), key resolution, designation + freeze.
    let caps: CapsStoreFile;
    try {
      caps = this.d.capsStore.read();
    } catch (err) {
      throw new MoneyGateRefusal('invalid-cap', `caps store unreadable: ${String(err)}`, undefined, req.door);
    }
    const { keyRef, keyCaps, valid } = this.liveKeyChecks(caps, req.door);
    // 4) Bounded reservation (A2-4).
    if (
      req.maxOutputTokens === undefined || !Number.isFinite(req.maxOutputTokens) || req.maxOutputTokens <= 0 ||
      !Number.isFinite(req.inputTokens) || req.inputTokens < 0
    ) {
      throw new MoneyGateRefusal('unbounded-reservation', 'metered call without a bounded max_tokens output ceiling (or invalid input estimate) is refused', keyRef, req.door);
    }
    const isProof = req.caller === 'release-proof' && isReleaseProofMarker(proofMarker, req.door);
    // 5) Canonical VALIDATED price only (never observed, never overlay), tier + stale policy applied.
    const price = this.gatePrice(req, keyRef, isProof);
    // 6) Worst-case reserve at BASE price; cached tokens as FULL input (FD-19).
    const reserveUsd = (req.inputTokens / 1e6) * price.inPerMtok + (req.maxOutputTokens / 1e6) * price.outPerMtok;
    const zone = periodTimeZoneOf(keyCaps);
    // 7+8) ATOMIC check-and-reserve: the strict-> cap comparison runs INSIDE the
    // ledger's per-key booking critical section (never outside it — the only
    // ordering under which two CONCURRENT reservations are guaranteed to see
    // each other; the two-concurrent-reserves unit test pins this). The policy
    // is RE-READ inside that section (§5 step 5), so a caller disabled or a cap
    // lowered while the token count ran is honoured at the moment of booking.
    let handle: ReserveHandle;
    try {
      handle = await this.d.ledger.reserve({
        keyRef,
        door: req.door,
        modelId: req.modelId,
        reserveUsd,
        leaseEpoch: caps.leaseEpoch,
        admitOnlyUnderCaps: this.admitCapsFor(caps, req.door, valid),
        revalidateUnderLock: () => this.policyUnderLock(req, keyRef, proofMarker),
        periodTimeZone: zone,
        component: req.component,
        caller: req.caller,
        ...(req.callId ? { callId: req.callId } : {}),
        ...(req.requestSha256 ? { requestSha256: req.requestSha256 } : {}),
        ...(req.run ? { run: req.run } : {}),
        ...(price.pointId ? { pricePointId: price.pointId } : {}),
        ...(price.tier ? { tier: price.tier } : {}),
        ...(req.caller === 'spec-review' && req.e1Pass ? { e1PassKey: `${req.e1Pass.specSha256}#${req.e1Pass.round}` } : {}),
        bookedInPerMtok: price.inPerMtok,
        bookedOutPerMtok: price.outPerMtok,
      });
    } catch (err) {
      throw this.mapReserveError(err, keyRef, req.door);
    }
    if (handle.deduped) {
      const v = this.d.ledger.reservation(handle.reserveId);
      if (v) return this.dedupeResult(req, v);
    }
    try {
      this.d.onGateEvent?.({
        type: 'admit',
        keyRef,
        door: req.door,
        committedLifetimeUsd: handle.committedLifetimeUsd,
        committedDayUsd: handle.committedDayUsd,
        lifetimeCapUsd: valid.lifetime ?? 0,
        dailyCapUsd: valid.daily,
      });
    } catch {
      // @silent-fallback-ok: the observer is signal-only — never on the admit path.
    }
    return {
      reserveId: handle.reserveId,
      keyRef,
      reserveUsd,
      bookedInPerMtok: price.inPerMtok,
      bookedOutPerMtok: price.outPerMtok,
      committedLifetimeUsd: handle.committedLifetimeUsd,
      committedDayUsd: handle.committedDayUsd,
      committedMonthUsd: handle.committedMonthUsd,
      pricePointId: price.pointId,
      state: handle.state,
    };
  }

  /** The reservation a callId is bound to (step-0 dedupe lookup for the entry path). */
  lookupCall(callId: string): ReservationView | null {
    return this.d.ledger.lookupCall(callId);
  }

  /**
   * Preflight headroom (§5 step 6): refuse at once when committed spend already
   * MEETS the month, day, lifetime or E2-share limit, so an exhausted caller
   * never pays for a token count. Returns null when headroom may exist.
   */
  preflightHeadroom(req: Pick<AdmitRequest, 'door' | 'caller'>): MoneyGateRefusal | null {
    let caps: CapsStoreFile;
    try {
      caps = this.d.capsStore.read();
    } catch (err) {
      return new MoneyGateRefusal('invalid-cap', `caps store unreadable: ${String(err)}`, undefined, req.door);
    }
    let checked: ReturnType<MeteredSpendGate['liveKeyChecks']>;
    try {
      checked = this.liveKeyChecks(caps, req.door);
    } catch (err) {
      if (err instanceof MoneyGateRefusal) return err;
      throw err;
    }
    const { keyRef, valid } = checked;
    const t = this.d.ledger.committed(keyRef);
    const limits = this.admitCapsFor(caps, req.door, valid);
    const meets = (committed: number, cap: number | undefined) => cap !== undefined && committed >= cap;
    if (req.caller === 'second-opinion' && limits.e2) {
      if (meets(t.e2MonthUsd, limits.e2.monthCapUsd)) return new MoneyGateRefusal('e2-share-exceeded', 'second-opinion month share already used', keyRef, req.door, { period: 'month', settledUsd: t.e2MonthUsd, capUsd: limits.e2.monthCapUsd });
      if (meets(t.e2DayUsd, limits.e2.dayCapUsd)) return new MoneyGateRefusal('e2-share-exceeded', 'second-opinion day share already used', keyRef, req.door, { period: 'day', settledUsd: t.e2DayUsd, capUsd: limits.e2.dayCapUsd });
    }
    if (meets(t.committedMonthUsd, limits.monthlyCapUsd)) return new MoneyGateRefusal('cap-exceeded', 'the monthly cap is already reached', keyRef, req.door, { period: 'month', settledUsd: t.committedMonthUsd, capUsd: limits.monthlyCapUsd });
    if (meets(t.committedDayUsd, limits.dailyCapUsd)) return new MoneyGateRefusal('cap-exceeded', 'the daily cap is already reached', keyRef, req.door, { period: 'day', settledUsd: t.committedDayUsd, capUsd: limits.dailyCapUsd });
    if (meets(t.committedLifetimeUsd, limits.lifetimeCapUsd)) return new MoneyGateRefusal('cap-exceeded', 'the lifetime cap is already reached', keyRef, req.door, { period: 'lifetime', settledUsd: t.committedLifetimeUsd, capUsd: limits.lifetimeCapUsd });
    return null;
  }

  /** Steps 1–3: go-live, designation, lease self-fence, freeze, cap validity. Throws MoneyGateRefusal. */
  private liveKeyChecks(caps: CapsStoreFile, door: string): { keyRef: string; keyCaps: KeyCapsRecord | undefined; valid: { lifetime?: number; monthly?: number; daily: number } } {
    const goLive = caps.goLive[door];
    if (!goLive || !goLive.enabled) {
      throw new MoneyGateRefusal('not-live', `door '${door}' has no live go-live record (deny-by-default)`, undefined, door);
    }
    const keyRef = goLive.keyRef;
    if (goLive.designatedMachineId !== this.d.machineId) {
      throw new MoneyGateRefusal('no-cap-slice', `this machine holds no cap authority for '${door}' (designated: ${goLive.designatedMachineId})`, keyRef, door);
    }
    // 2) Self-fence: positive lease re-confirmation within the bounded window (N-2).
    //    The reserved cap-gate probe door is exempt. It is machine-local (designated to
    //    this machine by `ensureProbeDoor`, a $0.01 cap, no provider behind it — an admit
    //    there can never bill), and the lease input is the METERED door's designation
    //    echo, which says nothing about it. Without the exemption every pool agent's boot
    //    probe ran before the first echo was confirmed, refused for the wrong reason
    //    (`lease-liveness-unconfirmed`), and left the money layer `probe-failed` after
    //    every restart — found by the gemini-payg user-role live test on a real
    //    two-machine pair (spec §8 "PROBE_DOOR is unaffected ... so enforcementReady
    //    keeps working").
    const confirmedAgo = door === PROBE_DOOR ? 0 : this.d.leaseConfirmedAgoMs();
    if (confirmedAgo === null || confirmedAgo > LEASE_LIVENESS_WINDOW_MS) {
      throw new MoneyGateRefusal('lease-liveness-unconfirmed', `metered-lease designation not positively re-confirmed within ${LEASE_LIVENESS_WINDOW_MS}ms (ago: ${confirmedAgo ?? 'never'})`, keyRef, door);
    }
    // 3) Freeze + cap validity (a monthly-only record is valid — gemini-payg §5).
    const keyCaps = caps.caps[keyRef];
    if (keyCaps?.frozen) {
      throw new MoneyGateRefusal('frozen', `key '${keyRef}' is frozen${keyCaps.frozenBy ? ` (by ${keyCaps.frozenBy})` : ''}`, keyRef, door);
    }
    const v = capsValidity(keyCaps);
    if (!v.ok) {
      throw new MoneyGateRefusal('invalid-cap', `key '${keyRef}' has no valid positive caps (a cap of 0/absent admits nothing)`, keyRef, door);
    }
    return { keyRef, keyCaps, valid: v };
  }

  /** The limits the ledger checks under its lock, from the key caps plus the door policy. */
  private admitCapsFor(caps: CapsStoreFile, door: string, valid: { lifetime?: number; monthly?: number; daily: number }): AdmitCaps {
    const policy = caps.doorPolicy?.[door];
    const out: AdmitCaps = {
      dailyCapUsd: valid.daily,
      ...(valid.lifetime !== undefined ? { lifetimeCapUsd: valid.lifetime } : {}),
      ...(valid.monthly !== undefined ? { monthlyCapUsd: valid.monthly } : {}),
    };
    if (policy) {
      out.perCallCeilingUsd = policy.perCallCeilingUsd;
      out.provisionalCeilingUsd = policy.provisionalCeilingUsd;
      out.e1PassLimit = policy.e1PassesPerRound;
      out.e2 = {
        dayCapUsd: policy.e2DayCapUsd,
        // The month share is a share OF the monthly cap; with no monthly cap the share has no base and admits nothing.
        monthCapUsd: valid.monthly !== undefined ? (valid.monthly * policy.e2MonthSharePct) / 100 : 0,
      };
    }
    return out;
  }

  /**
   * The in-lock policy re-read (§5 step 5): live, freeze, designation, caps,
   * and — for a door with a policy — caller membership, E3 components and
   * release state. Throws MoneyGateRefusal; returns the fresh limits.
   */
  private policyUnderLock(req: AdmitRequest, keyRef: string, proofMarker: unknown): AdmitCaps {
    let caps: CapsStoreFile;
    try {
      caps = this.d.capsStore.read();
    } catch (err) {
      throw new MoneyGateRefusal('invalid-cap', `caps store unreadable under the reservation lock: ${String(err)}`, keyRef, req.door);
    }
    const { keyRef: freshKey, valid } = this.liveKeyChecks(caps, req.door);
    if (freshKey !== keyRef) {
      throw new MoneyGateRefusal('not-live', `door '${req.door}' was re-designated to a different key while the call was being prepared`, keyRef, req.door);
    }
    // Every door but the reserved cap-gate probe re-checks the caller here (a door
    // with no policy refuses). The probe door is exempt so `enforcementReady`
    // keeps proving the cap comparison (spec §8 "PROBE_DOOR is unaffected").
    if (req.door !== PROBE_DOOR) {
      const refusal = callerAdmissionRefusal(caps, req, proofMarker);
      if (refusal) throw refusal;
    }
    return this.admitCapsFor(caps, req.door, valid);
  }

  private dedupeResult(req: AdmitRequest, v: ReservationView): AdmitResult {
    const conflict = callIdConflict(req, v);
    if (conflict) throw conflict;
    const t = this.d.ledger.committed(v.keyRef);
    return {
      reserveId: v.reserveId,
      keyRef: v.keyRef,
      reserveUsd: v.reserveUsd,
      bookedInPerMtok: v.bookedInPerMtok ?? 0,
      bookedOutPerMtok: v.bookedOutPerMtok ?? 0,
      committedLifetimeUsd: t.committedLifetimeUsd,
      committedDayUsd: t.committedDayUsd,
      committedMonthUsd: t.committedMonthUsd,
      pricePointId: v.pricePointId ?? null,
      deduped: true,
      state: v.state,
    };
  }

  /** Map a ledger reserve failure onto the closed refusal set. */
  private mapReserveError(err: unknown, keyRef: string, door: string): MoneyGateRefusal {
    if (err instanceof MoneyGateRefusal) return err;
    if (err instanceof CallIdConflictError) return new MoneyGateRefusal('callid-conflict', err.message, keyRef, door);
    if (err instanceof E1PassLimitError) return new MoneyGateRefusal('e1-pass-limit', err.message, keyRef, door, { resetsAt: null });
    if (err instanceof CapExceededError) {
      const base = { settledUsd: err.settledUsd, outstandingUsd: err.outstandingUsd, capUsd: err.capUsd, resetsAt: err.resetsAt };
      let refusal: MoneyGateRefusal;
      if (err.capKind === 'per-call') {
        refusal = new MoneyGateRefusal('per-call-ceiling', err.message, keyRef, door, { ...base, period: 'call', resetsAt: null });
      } else if (err.capKind === 'provisional') {
        refusal = new MoneyGateRefusal('provisional-ceiling', err.message, keyRef, door, { ...base, period: 'provisional' });
      } else if (err.reservesOutstanding) {
        refusal = new MoneyGateRefusal('reserves-outstanding', err.message, keyRef, door, { ...base, retryAfterSec: err.retryAfterSec ?? 1 });
      } else if (err.capKind === 'e2-month' || err.capKind === 'e2-day') {
        refusal = new MoneyGateRefusal('e2-share-exceeded', err.message, keyRef, door, { ...base, period: err.capKind === 'e2-month' ? 'month' : 'day' });
      } else {
        const period: RefusalPeriod = err.capKind === 'monthly' ? 'month' : err.capKind === 'daily' ? 'day' : 'lifetime';
        refusal = new MoneyGateRefusal('cap-exceeded', err.message, keyRef, door, { ...base, period });
      }
      if (refusal.reason === 'cap-exceeded') {
        try {
          this.d.onGateEvent?.({ type: 'refusal', reason: 'cap-exceeded', keyRef, door, detail: err.message });
        } catch {
          // @silent-fallback-ok: the observer is signal-only — never on the refusal path.
        }
      }
      return refusal;
    }
    return new MoneyGateRefusal('ledger-error', `reserve booking failed: ${String(err)}`, keyRef, door);
  }

  /**
   * The gate-eligible price for a request: the CANONICAL as-of point,
   * validated + plausibility-floored; under a stale SLA the door's staleMode
   * applies (default book-conservative-max — spend continues, never under-books).
   * A door with `requireVerifiedTier` selects its point by COUNTED input range
   * (gemini-payg §3); only the release-proof call may book an unverified point,
   * and it books at conservativeMax.
   */
  private gatePrice(req: AdmitRequest, keyRef: string, isProof: boolean): { inPerMtok: number; outPerMtok: number; pointId: string | null; tier: string | null } {
    const door = req.door;
    const modelId = req.modelId;
    const nowMs = this.now();
    const meta = this.d.prices.doorMetaFor(door);
    const res = this.d.prices.resolve(door, modelId, nowMs);
    if (meta?.requireVerifiedTier) {
      if (req.inputTokensCounted !== true) {
        throw new MoneyGateRefusal('token-count-unavailable', `door '${door}' prices by the COUNTED input; an estimate is refused (no estimated fallback)`, keyRef, door);
      }
      const sel = this.d.prices.selectTier(door, modelId, nowMs, req.inputTokens, { allowUnverified: isProof });
      if (!sel.ok) throw new MoneyGateRefusal(sel.reason, sel.detail, keyRef, door);
      if (req.tierPointId && req.tierPointId !== sel.pointId) {
        throw new MoneyGateRefusal('outside-verified-tier', `the price tier changed since it was previewed (${req.tierPointId} → ${sel.pointId})`, keyRef, door);
      }
      const tier = String(sel.point.maxInputTokens ?? 'any');
      // Staleness of THE SELECTED POINT (spec §3: "once a point is past its 45-day
      // freshness window it refuses"), not of the door's newest point.
      const slaDays = meta.freshnessSlaDays ?? DEFAULT_FRESHNESS_SLA_DAYS;
      const pointAgeStale = (nowMs - Date.parse(sel.point.effectiveAt)) / 86_400_000 > slaDays;
      if (pointAgeStale && (meta.staleMode ?? 'book-conservative-max') === 'fail-closed') {
        throw new MoneyGateRefusal('stale-price-fail-closed', `canonical price for '${door}' is older than its freshness SLA and staleMode is fail-closed`, keyRef, door);
      }
      if (!sel.verified || pointAgeStale) {
        // Only reachable for the proof call (unverified) or a book-conservative-max door (age-stale).
        const cm = meta.conservativeMax;
        if (!cm || !this.plausible(door, cm.inPerMtok, cm.outPerMtok)) {
          throw new MoneyGateRefusal('unknown-price', `unverified/stale price for '${door}' and no plausible conservativeMax to book against`, keyRef, door);
        }
        return { inPerMtok: cm.inPerMtok, outPerMtok: cm.outPerMtok, pointId: sel.pointId, tier };
      }
      if (!this.plausible(door, sel.point.inPerMtok, sel.point.outPerMtok)) {
        throw new MoneyGateRefusal('implausible-price', `canonical price for (${door}, ${modelId}) is below the code-defined provider floor — likely a typo`, keyRef, door);
      }
      return { inPerMtok: sel.point.inPerMtok, outPerMtok: sel.point.outPerMtok, pointId: sel.pointId, tier };
    }
    // Canonical ONLY: an observed point is structurally not gate-eligible (S2-2).
    if (res.priceBasis !== 'canonical' || !res.point) {
      throw new MoneyGateRefusal('unknown-price', `no canonical price point for (${door}, ${modelId})`, keyRef, door);
    }
    const pointId = pricePointId(res.point);
    if (res.priceStale) {
      // `verified: false` folds into priceStale (gemini-payg §3) and takes the same path.
      const mode = meta?.staleMode ?? 'book-conservative-max';
      if (mode === 'fail-closed') {
        throw new MoneyGateRefusal('stale-price-fail-closed', `canonical price for '${door}' is older than its freshness SLA (or unverified) and staleMode is fail-closed`, keyRef, door);
      }
      const cm = meta?.conservativeMax;
      if (!cm || !this.plausible(door, cm.inPerMtok, cm.outPerMtok)) {
        throw new MoneyGateRefusal('unknown-price', `stale price for '${door}' and no plausible conservativeMax to book against`, keyRef, door);
      }
      return { inPerMtok: cm.inPerMtok, outPerMtok: cm.outPerMtok, pointId, tier: null };
    }
    const pt = res.point;
    if (!this.plausible(door, pt.inPerMtok, pt.outPerMtok)) {
      throw new MoneyGateRefusal('implausible-price', `canonical price for (${door}, ${modelId}) is below the code-defined provider floor — likely a typo`, keyRef, door);
    }
    return { inPerMtok: pt.inPerMtok, outPerMtok: pt.outPerMtok, pointId, tier: null };
  }

  private plausible(door: string, inPerMtok: number, outPerMtok: number): boolean {
    const provider = door.split('-')[0]; // gemini-api → gemini … door naming is provider-prefixed
    const floor =
      PROVIDER_PRICE_FLOORS_PER_MTOK[provider] ??
      PROVIDER_PRICE_FLOORS_PER_MTOK[{ gemini: 'google' }[provider] ?? ''] ??
      { inPerMtok: 0.001, outPerMtok: 0.001 };
    return (
      Number.isFinite(inPerMtok) && Number.isFinite(outPerMtok) &&
      inPerMtok >= floor.inPerMtok && outPerMtok >= floor.outPerMtok
    );
  }

  /**
   * Settle helpers for the (future) metered dispatch seam: ALL no-charge outcomes
   * force-settle $0 (A-B2) unless tokens were demonstrably returned; a 200 books
   * actual from the per-door BILLED-token mapping (erring HIGH), or worst-case
   * when the billed basis cannot be confirmed.
   */
  async settleActual(keyRef: string, reserveId: string, actualUsd: number): Promise<void> {
    await this.d.ledger.settle(keyRef, reserveId, actualUsd);
  }

  /** Confirmed no-charge (a rejection before generation): $0, and an E1 pass slot is released. */
  async settleNoCharge(keyRef: string, reserveId: string): Promise<void> {
    await this.d.ledger.settle(keyRef, reserveId, 0, { noCharge: true });
  }

  /** Post-send failure (5xx / timeout / abort / drop): a provisional charge at the full reserve (§5). */
  async settleProvisional(keyRef: string, reserveId: string): Promise<void> {
    await this.d.ledger.settleProvisional(keyRef, reserveId);
  }

  /**
   * Settle from reported usage at the RESERVED point's rates (gemini-payg §5:
   * "settle uses that same point"), never a re-resolved price. A reservation
   * with no stored rates (pre-change) settles at the full reserve, the safe
   * direction. Returns the booked amount.
   */
  async settleFromUsage(keyRef: string, reserveId: string, usage: { promptTokens: number; billedOutputTokens: number | null }): Promise<number> {
    const v = this.d.ledger.reservation(reserveId);
    const inRate = v?.bookedInPerMtok;
    const outRate = v?.bookedOutPerMtok;
    let usd: number;
    if (
      !v || inRate === undefined || outRate === undefined || usage.billedOutputTokens === null ||
      !Number.isFinite(usage.promptTokens) || usage.promptTokens < 0 || !Number.isFinite(usage.billedOutputTokens) || usage.billedOutputTokens < 0
    ) {
      usd = v?.reserveUsd ?? 0;
    } else {
      usd = (usage.promptTokens / 1e6) * inRate + (usage.billedOutputTokens / 1e6) * outRate;
    }
    await this.d.ledger.settle(keyRef, reserveId, usd);
    return usd;
  }
}

/**
 * Per-door BILLED-token mapping (Layer 3): which response fields mean "billed
 * output" for each metered door — Gemini bills thinking tokens as output
 * (candidatesTokenCount can EXCLUDE them); OpenRouter/Groq bill
 * completion_tokens. A response whose billed basis cannot be confirmed from the
 * mapping settles at the WORST-CASE estimate, never a lower unverified field.
 * Named + exported so the metered dispatch seam and the tests share ONE truth.
 */
export function billedOutputTokens(door: string, usage: Record<string, unknown> | undefined): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  if (door === 'gemini-api') {
    // Native path: candidatesTokenCount + thoughtsTokenCount. OpenAI-compat path:
    // completion_tokens (+ reasoning tokens detail when present).
    const candidates = n(usage['candidatesTokenCount']);
    if (candidates !== null) {
      const thoughts = n(usage['thoughtsTokenCount']) ?? 0;
      return candidates + thoughts;
    }
    const completion = n(usage['completion_tokens']);
    if (completion !== null) {
      const details = usage['completion_tokens_details'] as Record<string, unknown> | undefined;
      const reasoning = n(details?.['reasoning_tokens']) ?? 0;
      // completion_tokens on the compat path already includes reasoning on some
      // shapes; take the MAX interpretation (erring HIGH, the safe direction).
      return Math.max(completion, reasoning);
    }
    return null;
  }
  if (door === 'openrouter-api' || door === 'groq-api') {
    return n(usage['completion_tokens']);
  }
  return null;
}
