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

import { CapExceededError } from './MeteredSpendLedger.js';
import type { MeteredSpendLedger, ReserveHandle } from './MeteredSpendLedger.js';
import type { RoutingPriceAuthority, RoutingPricePoint } from './routingPriceAuthority.js';
import type { RoutingSpendCapsStore, CapsStoreFile } from './RoutingSpendCapsStore.js';

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
  | 'ledger-error';

/** A cap/uncertainty refusal — the router treats it as a swap-tail ADVANCE, never a chain kill. */
export class MoneyGateRefusal extends Error {
  constructor(
    public reason: MoneyGateRefusalReason,
    public detail: string,
    public keyRef?: string,
    public door?: string,
  ) {
    super(`money gate refused (${reason}): ${detail}`);
    this.name = 'MoneyGateRefusal';
  }
}

export interface AdmitRequest {
  door: string;
  modelId: string;
  /** Prompt tokens (estimated or counted). Cached tokens reserve as FULL input (FD-19) — no cached discount at reserve time. */
  inputTokens: number;
  /** REQUIRED bounded output ceiling — the metered request MUST set max_tokens (A2-4). */
  maxOutputTokens: number | undefined;
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
   */
  async admit(req: AdmitRequest): Promise<AdmitResult> {
    // 1) Go-live: deny-by-default (not-live), key resolution, designation + freeze.
    let caps: CapsStoreFile;
    try {
      caps = this.d.capsStore.read();
    } catch (err) {
      throw new MoneyGateRefusal('invalid-cap', `caps store unreadable: ${String(err)}`, undefined, req.door);
    }
    const goLive = caps.goLive[req.door];
    if (!goLive || !goLive.enabled) {
      throw new MoneyGateRefusal('not-live', `door '${req.door}' has no live go-live record (deny-by-default)`, undefined, req.door);
    }
    const keyRef = goLive.keyRef;
    if (goLive.designatedMachineId !== this.d.machineId) {
      throw new MoneyGateRefusal('no-cap-slice', `this machine holds no cap authority for '${req.door}' (designated: ${goLive.designatedMachineId})`, keyRef, req.door);
    }
    // 2) Self-fence: positive lease re-confirmation within the bounded window (N-2).
    const confirmedAgo = this.d.leaseConfirmedAgoMs();
    if (confirmedAgo === null || confirmedAgo > LEASE_LIVENESS_WINDOW_MS) {
      throw new MoneyGateRefusal('lease-liveness-unconfirmed', `metered-lease designation not positively re-confirmed within ${LEASE_LIVENESS_WINDOW_MS}ms (ago: ${confirmedAgo ?? 'never'})`, keyRef, req.door);
    }
    // 3) Freeze + cap validity.
    const keyCaps = caps.caps[keyRef];
    if (keyCaps?.frozen) {
      throw new MoneyGateRefusal('frozen', `key '${keyRef}' is frozen${keyCaps.frozenBy ? ` (by ${keyCaps.frozenBy})` : ''}`, keyRef, req.door);
    }
    const lifetimeCap = keyCaps?.lifetimeCapUsd;
    const dailyCap = keyCaps?.dailyCapUsd;
    if (
      typeof lifetimeCap !== 'number' || !Number.isFinite(lifetimeCap) || lifetimeCap <= 0 ||
      typeof dailyCap !== 'number' || !Number.isFinite(dailyCap) || dailyCap <= 0
    ) {
      throw new MoneyGateRefusal('invalid-cap', `key '${keyRef}' has no valid positive caps (a cap of 0/absent admits nothing)`, keyRef, req.door);
    }
    // 4) Bounded reservation (A2-4).
    if (
      req.maxOutputTokens === undefined || !Number.isFinite(req.maxOutputTokens) || req.maxOutputTokens <= 0 ||
      !Number.isFinite(req.inputTokens) || req.inputTokens < 0
    ) {
      throw new MoneyGateRefusal('unbounded-reservation', 'metered call without a bounded max_tokens output ceiling (or invalid input estimate) is refused', keyRef, req.door);
    }
    // 5) Canonical VALIDATED price only (never observed, never overlay), stale policy applied.
    const { inPerMtok, outPerMtok } = this.gatePrice(req.door, req.modelId, keyRef);
    // 6) Worst-case reserve at BASE price; cached tokens as FULL input (FD-19).
    const reserveUsd = (req.inputTokens / 1e6) * inPerMtok + (req.maxOutputTokens / 1e6) * outPerMtok;
    // 7+8) ATOMIC check-and-reserve: the strict-> cap comparison runs INSIDE the
    // ledger's per-key booking critical section (never outside it — the only
    // ordering under which two CONCURRENT reservations are guaranteed to see
    // each other; the two-concurrent-reserves unit test pins this). The read is
    // O(1) and fresh (high-water-checked) at the moment of booking.
    let handle: ReserveHandle;
    try {
      handle = await this.d.ledger.reserve({
        keyRef,
        door: req.door,
        modelId: req.modelId,
        reserveUsd,
        leaseEpoch: caps.leaseEpoch,
        admitOnlyUnderCaps: { lifetimeCapUsd: lifetimeCap, dailyCapUsd: dailyCap },
      });
    } catch (err) {
      if (err instanceof CapExceededError) {
        throw new MoneyGateRefusal('cap-exceeded', err.message, keyRef, req.door);
      }
      throw new MoneyGateRefusal('ledger-error', `reserve booking failed: ${String(err)}`, keyRef, req.door);
    }
    return {
      reserveId: handle.reserveId,
      keyRef,
      reserveUsd,
      bookedInPerMtok: inPerMtok,
      bookedOutPerMtok: outPerMtok,
      committedLifetimeUsd: handle.committedLifetimeUsd,
      committedDayUsd: handle.committedDayUsd,
    };
  }

  /**
   * The gate-eligible price for a (door, model): the CANONICAL as-of point,
   * validated + plausibility-floored; under a stale SLA the door's staleMode
   * applies (default book-conservative-max — spend continues, never under-books).
   */
  private gatePrice(door: string, modelId: string, keyRef: string): { inPerMtok: number; outPerMtok: number } {
    const res = this.d.prices.resolve(door, modelId, this.now());
    // Canonical ONLY: an observed point is structurally not gate-eligible (S2-2).
    if (res.priceBasis !== 'canonical' || !res.point) {
      throw new MoneyGateRefusal('unknown-price', `no canonical price point for (${door}, ${modelId})`, keyRef, door);
    }
    const meta = this.d.prices.doorMetaFor(door);
    if (res.priceStale) {
      const mode = meta?.staleMode ?? 'book-conservative-max';
      if (mode === 'fail-closed') {
        throw new MoneyGateRefusal('stale-price-fail-closed', `canonical price for '${door}' is older than its freshness SLA and staleMode is fail-closed`, keyRef, door);
      }
      const cm = meta?.conservativeMax;
      if (!cm || !this.plausible(door, cm.inPerMtok, cm.outPerMtok)) {
        throw new MoneyGateRefusal('unknown-price', `stale price for '${door}' and no plausible conservativeMax to book against`, keyRef, door);
      }
      return { inPerMtok: cm.inPerMtok, outPerMtok: cm.outPerMtok };
    }
    const pt = res.point;
    if (!this.plausible(door, pt.inPerMtok, pt.outPerMtok)) {
      throw new MoneyGateRefusal('implausible-price', `canonical price for (${door}, ${modelId}) is below the code-defined provider floor — likely a typo`, keyRef, door);
    }
    return { inPerMtok: pt.inPerMtok, outPerMtok: pt.outPerMtok };
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

  async settleNoCharge(keyRef: string, reserveId: string): Promise<void> {
    await this.d.ledger.settle(keyRef, reserveId, 0);
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
