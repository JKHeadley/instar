/**
 * meteredCallEntry — the entry path every paid call goes through
 * (docs/specs/money-layer-operator-enable-surface.md §5).
 *
 * THIS IS THE LOAD-BEARING PIECE. Without it, disable is cosmetic: the money
 * layer is constructed once at server start, so a layer that was constructed
 * while enabled would keep admitting after the operator turned it off. The
 * check therefore reads CURRENT state on every call, never a value captured at
 * construction (T15).
 *
 * WHY THE FREEZE CHECK LIVES HERE AND NOT INSIDE THE MONEY LAYER. If it lived
 * inside, a `construction-failed` layer would take the emergency brake down
 * with it — the one state where the operator is most likely to reach for it. So
 * the freeze check sits in the entry path, AHEAD of the money layer and
 * independent of whether that layer constructed, reading the freeze set
 * directly from the caps store on disk. This is spelled out because an
 * implementer would naturally place the brake inside the machinery it is meant
 * to survive.
 *
 * ORDER, and each step's reason (gemini-payg §2/§5 extends it):
 *   0. DEDUPE   — an authenticated callId resubmission returns the existing
 *                 call's state, never refused by a cap, freeze or disabled
 *                 caller: the call was already admitted and paid for.
 *   1. FREEZE   — the emergency stop, honoured regardless of intent, config,
 *                 lifecycle state or the single-instance lock. Read from DISK,
 *                 so a freeze written by a process that does NOT hold the lock
 *                 stops spend in the process that DOES (T34).
 *   2. SERVING  — the live enable check. `servingReady`, never `intentEnabled`:
 *                 asking for the layer on is not permission to spend (MLE-2).
 *   3. CALLER   — membership in the door's `meteredCallers` (and E3 component
 *                 membership); a missing caller refuses `not-allowlisted`.
 *   4. RELEASE  — `armed-pending-proof` admits only the release-proof call,
 *                 which needs a recorder-minted marker request input can never set.
 *   5. GATE     — per-call ceiling, caps, shares, prices, reservation, with the
 *                 policy re-read inside the reservation lock.
 *
 * WHERE THE READINESS PROBE ENTERS, and why that is not the bypass review
 * killed five times. The probe calls `MeteredSpendGate.admit` DIRECTLY, one
 * layer below this entry — it has to, because the enable check at step 2 is the
 * very thing the probe exists to establish, and running it through step 2 would
 * be circular: never ready, because not yet ready.
 *
 * That is a different thing from the removed bypass in every way that mattered.
 * The bypass SKIPPED THE CAP CHECK behind a capability token — a privileged
 * branch inside metered execution, reachable by a refactor or a leaked token.
 * The probe skips no check inside the gate at all: caps, price, freeze and the
 * reservation comparison all run in full, which is precisely what makes its
 * `cap-exceeded` refusal evidence. It skips only the two checks ABOVE the gate,
 * for a door whose provider makes no network call and whose cap is $0.01. There
 * is no conditional anywhere in the gate, and nothing here is keyed on a token
 * — only on a reserved door id that is refused as user input everywhere.
 *
 * HONEST SCOPE. instar has no live metered dispatch seam yet — no paid provider
 * call is made anywhere today. This module is therefore the chokepoint the
 * dispatch seam MUST call when it lands, established NOW so the ordering above
 * is a precondition of that work rather than a retrofit onto it. Until that
 * seam exists, the only caller of `gate.admit` in the codebase is the probe.
 */

import type { RoutingSpendCapsStore } from './RoutingSpendCapsStore.js';
import {
  MoneyGateRefusal,
  callerAdmissionRefusal,
  callIdConflict,
  type AdmitRequest,
  type AdmitResult,
  type ReleaseProofMarker,
} from './MeteredSpendGate.js';
import type { ReservationView } from './MeteredSpendLedger.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

/** Internal-only admission inputs — NEVER derived from request input. */
export interface MeteredCallInternal {
  /** Minted by the release-proof recorder only (slice E). */
  proofMarker?: ReleaseProofMarker;
}

export interface MeteredCallEntryDeps {
  /** Read DIRECTLY, ahead of the money layer — never through it. */
  capsStore: RoutingSpendCapsStore | null;
  /** The live enable predicate. Absent ⇒ refuse: an unanswerable question is not a yes. */
  servingReady: (() => boolean) | null;
  /** The constructed gate. Absent ⇒ refuse. */
  gate: {
    admit(req: AdmitRequest, proofMarker?: ReleaseProofMarker): Promise<AdmitResult>;
    /** Step-0 dedupe lookup (folded from the ledger, so it survives restart). */
    lookupCall?(callId: string): ReservationView | null;
    /** Preflight headroom (§5 step 6). */
    preflightHeadroom?(req: Pick<AdmitRequest, 'door' | 'caller'>): MoneyGateRefusal | null;
  } | null;
  /** Resolve door → keyRef for the freeze read, without entering the gate. */
  resolveKeyRef?: (door: string) => string | null;
}

/**
 * The freeze read, deliberately standalone: it must work when the money layer
 * did not construct. Returns the frozen keyRef, or null when nothing blocks.
 *
 * FAILS CLOSED on an unreadable store: a caps file we cannot read cannot prove
 * a key is unfrozen, and "we could not check the brake" is never a reason to
 * proceed.
 */
export function frozenKeyForDoor(capsStore: RoutingSpendCapsStore | null, door: string): { frozen: boolean; keyRef: string | null; unreadable: boolean } {
  if (!capsStore) return { frozen: true, keyRef: null, unreadable: true };
  let file;
  try {
    file = capsStore.read();
  } catch {
    return { frozen: true, keyRef: null, unreadable: true };
  }
  const keyRef = file.goLive[door]?.keyRef ?? null;
  if (!keyRef) return { frozen: false, keyRef: null, unreadable: false };
  return { frozen: file.caps[keyRef]?.frozen === true, keyRef, unreadable: false };
}

/**
 * Admit a metered call through the full entry path. Every refusal is a
 * `MoneyGateRefusal`, so callers handle one error type.
 */
export async function admitMeteredCall(deps: MeteredCallEntryDeps, req: AdmitRequest, internal?: MeteredCallInternal): Promise<AdmitResult> {
  try {
    const admitted = await admitThroughEntryPath(deps, req, internal);
    featureEvidence.record('routingSpend.money', {
      kind: 'fired',
      reason: 'metered-call-admitted',
      context: { door: req.door, modelId: req.modelId, keyRef: admitted.keyRef, reserveUsd: admitted.reserveUsd, committedDayUsd: admitted.committedDayUsd },
    });
    return admitted;
  } catch (err) {
    const refusal = err instanceof MoneyGateRefusal ? err : null;
    featureEvidence.record('routingSpend.money', {
      kind: 'error',
      reason: refusal ? `refused: ${refusal.reason}` : 'admission-failed',
      context: { door: req.door, modelId: req.modelId, keyRef: refusal?.keyRef ?? null },
    });
    throw err;
  }
}

/**
 * The checks that must pass BEFORE the key is used at all (§5 step 1): dedupe,
 * freeze, live, caller, release state — then, when the gate offers it, the
 * headroom preflight (committed already meets a limit ⇒ refuse without paying
 * for a token count). `deduped` means the call already exists: skip the token
 * count and the send, and resume by callId.
 */
export type MeteredPreflight = { kind: 'proceed' } | { kind: 'deduped'; reservation: ReservationView };

export async function preflightMeteredCall(deps: MeteredCallEntryDeps, req: AdmitRequest, internal?: MeteredCallInternal): Promise<MeteredPreflight> {
  const dedupe = dedupeLookup(deps, req);
  if (dedupe) return { kind: 'deduped', reservation: dedupe };
  entryChecks(deps, req, internal);
  const headroom = deps.gate?.preflightHeadroom?.(req) ?? null;
  if (headroom) throw headroom;
  return { kind: 'proceed' };
}

function dedupeLookup(deps: MeteredCallEntryDeps, req: AdmitRequest): ReservationView | null {
  if (!req.callId || !deps.gate?.lookupCall) return null;
  const existing = deps.gate.lookupCall(req.callId);
  if (!existing) return null;
  const conflict = callIdConflict(req, existing);
  if (conflict) throw conflict;
  return existing;
}

/** Steps 1–4 (freeze, live, caller, release state). Throws MoneyGateRefusal. */
function entryChecks(deps: MeteredCallEntryDeps, req: AdmitRequest, internal?: MeteredCallInternal): void {
  // 1) FREEZE — before anything else, and independent of the money layer.
  const freeze = frozenKeyForDoor(deps.capsStore, req.door);
  if (freeze.unreadable) {
    throw new MoneyGateRefusal('invalid-cap', 'the caps store could not be read, so the freeze state is unknown — refusing (fail closed)', undefined, req.door);
  }
  if (freeze.frozen) {
    throw new MoneyGateRefusal('frozen', `key '${freeze.keyRef}' is frozen — refused regardless of the enable state`, freeze.keyRef ?? undefined, req.door);
  }

  // 2) The LIVE enable check. This is what makes disable real rather than cosmetic.
  if (!deps.servingReady) {
    throw new MoneyGateRefusal('not-live', 'the money-layer enable surface is unavailable, so spend permission cannot be established — refusing (fail closed)', undefined, req.door);
  }
  if (!deps.servingReady()) {
    throw new MoneyGateRefusal('not-live', 'money-layer-disabled: the spending-control layer is not up and enforcing on this machine', undefined, req.door);
  }

  // 3+4) Caller membership (E3 components), then release state. The caps store
  // was readable a moment ago (step 1); a read failure here still fails closed.
  let file;
  try {
    file = deps.capsStore!.read();
  } catch {
    throw new MoneyGateRefusal('invalid-cap', 'the caps store could not be read for the caller check — refusing (fail closed)', undefined, req.door);
  }
  const refusal = callerAdmissionRefusal(file, req, internal?.proofMarker);
  if (refusal) throw refusal;
}

async function admitThroughEntryPath(deps: MeteredCallEntryDeps, req: AdmitRequest, internal?: MeteredCallInternal): Promise<AdmitResult> {
  // 0) DEDUPE — an already-admitted call is returned through the gate's own
  // dedupe (which never re-checks caps, freeze or caller).
  if (deps.gate && dedupeLookup(deps, req)) {
    return deps.gate.admit(req, internal?.proofMarker);
  }
  entryChecks(deps, req, internal);

  // 5) The gate: per-call ceiling, caps, shares, prices, reservation.
  if (!deps.gate) {
    throw new MoneyGateRefusal('not-live', 'the metered spend gate is not constructed on this machine', undefined, req.door);
  }
  return deps.gate.admit(req, internal?.proofMarker);
}
