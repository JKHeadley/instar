/**
 * moneyLayerProbe — the cap-gate readiness probe door
 * (docs/specs/money-layer-operator-enable-surface.md §6).
 *
 * A CAP-GATE readiness probe — its name is its scope. It proves cap enforcement
 * is wired and refusing; it does NOT exercise provider credentials, booking
 * commit or downstream execution. `enforcementReady` therefore means
 * "spending controls are up and enforcing", never "spend works" (T16 carries
 * the full-path coverage the probe deliberately does not).
 *
 * THERE IS NO BYPASS. Earlier drafts reached the cap check behind a capability
 * token — a privileged execution path inside the money path. Review challenged
 * it in five separate rounds; fencing it better was the wrong answer five times
 * running. Instead there is a probe DOOR that is genuinely live and
 * structurally cannot bill, and the probe is an ORDINARY metered call on the
 * ORDINARY path. Nothing is skipped, nothing is privileged, and the thing being
 * proven — *the cap gate refuses on the path that spends* — is proven by the
 * path that spends.
 *
 * WHAT ACTUALLY PREVENTS SPEND, stated at the strength the code supports
 * (second-pass finding 8 corrected an overclaim here):
 *   1. THE CAP — $0.01 against a $2.00 evaluation, so the gate refuses before
 *      any execution could be reached. This one is real today and is doing the
 *      work.
 *   2. The provider id `null-provider` is a NAME, not an implemented no-op
 *      object: instar has no metered provider dispatch at all yet, so nothing
 *      dispatches this door. When a dispatch seam lands, that id MUST resolve
 *      to a genuine no-op — an obligation on that work, not a guarantee this
 *      module can currently make.
 *
 * TWO BUILD-TIME CORRECTIONS to the reviewed design are recorded here, because
 * both are the same class of defect — a spec claim about the gate that the gate
 * itself contradicts, surviving 40 review rounds because reviewers read the
 * spec and not `MeteredSpendGate.ts`:
 *
 *   (a) THE PRICE MUST BE POSITIVE. With a $0 price, $0 usage does not exceed
 *       a $0 cap, so the probe would never trip the gate and readiness could
 *       never pass.
 *   (b) THE CAP MUST ALSO BE POSITIVE. `MeteredSpendGate.admit` step 3 refuses
 *       a key whose caps are `<= 0` with `invalid-cap` — "a cap of 0/absent
 *       admits nothing" — BEFORE it ever reaches the cap comparison. A $0 cap
 *       would have refused for the WRONG REASON, and the cause-check below
 *       would have correctly scored that as a probe failure: readiness could
 *       never pass. So the cap is $0.01 and the evaluation reserves $2.00
 *       against it, making the refusal a genuine `cap-exceeded`.
 *
 * A THIRD divergence from the spec text, deliberate and recorded: the spec says
 * the synthetic price lives "in the price manifest". It does NOT — it is
 * code-defined here. Three reasons, each of which would otherwise be a live
 * failure mode: a manifest entry IS operator-editable (the spec's own
 * requirement says it must not be), a manifest point AGES and would eventually
 * resolve stale so the probe would refuse for a price reason rather than a cap
 * reason, and the manifest is absent on a no-source install. A code-defined
 * price has none of those. `RoutingPriceAuthority.resolve()` short-circuits the
 * reserved door onto this constant.
 */

import type { CapsStoreFile } from './RoutingSpendCapsStore.js';

/** The reserved probe keyRef AND door id. Refused as a user-supplied keyRef everywhere (T8). */
export const PROBE_KEY_REF = '__probe__';
export const PROBE_DOOR = '__probe__';

/**
 * The probe door's provider id.
 *
 * HONEST WORDING (second-pass finding 8): this is a NAME, not an implemented
 * no-op provider object — instar has no metered provider dispatch at all yet,
 * so no provider code runs for any door. The accurate claim is therefore
 * "nothing dispatches this door, and when a dispatch seam exists this id must
 * resolve to a no-op", NOT "a no-op implementation exists today". The billing
 * protection that IS real right now is the cap: the gate refuses before any
 * execution could be reached.
 */
export const PROBE_PROVIDER = 'null-provider';
export const PROBE_MODEL_ID = 'null-provider';

/** Fixed positive synthetic price, per million tokens. Code-defined, never operator-editable, never stale. */
export const PROBE_PRICE_PER_MTOK = 1.0;

/** A tiny POSITIVE cap — NOT $0, which the gate refuses as `invalid-cap` before the comparison. */
export const PROBE_CAP_USD = 0.01;

/**
 * The evaluation request. 1M input + 1M output at $1.00/Mtok reserves $2.00,
 * which overshoots the $0.01 cap by 200x — so the refusal is unambiguously the
 * cap comparison and not a rounding artefact.
 */
export const PROBE_INPUT_TOKENS = 1_000_000;
export const PROBE_MAX_OUTPUT_TOKENS = 1_000_000;
export const PROBE_EVALUATED_USD = (PROBE_INPUT_TOKENS / 1e6) * PROBE_PRICE_PER_MTOK + (PROBE_MAX_OUTPUT_TOKENS / 1e6) * PROBE_PRICE_PER_MTOK;

export function isReservedProbeKeyRef(v: unknown): boolean {
  return v === PROBE_KEY_REF;
}

export function isReservedProbeDoor(v: unknown): boolean {
  return v === PROBE_DOOR;
}

/**
 * Install the reserved door into a caps-store snapshot. Idempotent, and
 * deliberately expressed as a pure function over the file so the same shape is
 * used by construction, by migration, and by the T41 exclusion tests.
 */
export function withProbeDoor(file: CapsStoreFile, machineId: string, nowIso: string): CapsStoreFile {
  const out = structuredClone(file);
  out.caps[PROBE_KEY_REF] = {
    provider: PROBE_PROVIDER,
    lifetimeCapUsd: PROBE_CAP_USD,
    dailyCapUsd: PROBE_CAP_USD,
    frozen: false,
  };
  out.goLive[PROBE_DOOR] = {
    keyRef: PROBE_KEY_REF,
    enabled: true, // deliberately LIVE, so the go-live check PASSES and nothing is skipped
    designatedMachineId: machineId,
    designatedAt: nowIso,
    epoch: out.goLive[PROBE_DOOR]?.epoch ?? 0,
  };
  return out;
}

export type ProbeVerdict =
  | { passed: true; evaluatedUsd: number; refusalReason: 'cap-exceeded' }
  | { passed: false; failingComponent: string; refusalReason: string | null };

export interface ProbeAdmitLike {
  admit(req: { door: string; modelId: string; inputTokens: number; maxOutputTokens: number | undefined }): Promise<unknown>;
}

/**
 * Settles a reservation to $0. Supplied so the ADMITTED failure path can undo
 * the booking it caused (see below).
 */
export interface ProbeSettleLike {
  settle(keyRef: string, reserveId: string, actualUsd: number): Promise<void>;
}

/**
 * Run the probe and CAUSE-CHECK the result.
 *
 * The cause check is the whole point: a refusal for the WRONG REASON is a probe
 * FAILURE, never a pass. "door not armed", "unknown key", "malformed",
 * "invalid-cap" and "unknown-price" are all refusals — and every one of them
 * means cap enforcement was never reached, so none may be read as enforcement.
 *
 * An ADMIT is also a failure, and the loudest one: the gate let a $2.00
 * reservation through a $0.01 cap.
 *
 * Unmeasurable ⇒ `unknown` ⇒ NOT ready (P20).
 */
export async function runCapGateProbe(
  gate: ProbeAdmitLike,
  capsSnapshot: CapsStoreFile | null,
  ledger?: ProbeSettleLike | null,
): Promise<ProbeVerdict> {
  // Preconditions asserted FIRST, so "door not armed" and "unknown key" can
  // never be mistaken for enforcement.
  if (!capsSnapshot) {
    return { passed: false, failingComponent: 'caps-store-unreadable', refusalReason: null };
  }
  const goLive = capsSnapshot.goLive[PROBE_DOOR];
  if (!goLive || !goLive.enabled) {
    return { passed: false, failingComponent: 'probe-door-not-live', refusalReason: null };
  }
  const caps = capsSnapshot.caps[PROBE_KEY_REF];
  if (!caps || !(caps.lifetimeCapUsd > 0) || !(caps.dailyCapUsd > 0)) {
    // The (b) correction, asserted rather than assumed: a non-positive cap
    // would refuse as `invalid-cap` before the comparison the probe exists to
    // exercise.
    return { passed: false, failingComponent: 'probe-cap-not-positive', refusalReason: null };
  }
  if (caps.frozen) {
    return { passed: false, failingComponent: 'probe-key-frozen', refusalReason: null };
  }

  let refusalReason: string | null = null;
  try {
    const admitted = (await gate.admit({
      door: PROBE_DOOR,
      modelId: PROBE_MODEL_ID,
      inputTokens: PROBE_INPUT_TOKENS,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    })) as { reserveId?: string; keyRef?: string } | undefined;
    // ADMITTED. The gate let a $2.00 reservation through a $0.01 cap — the
    // loudest possible failure.
    //
    // SECOND-PASS FINDING 8 — an admit BOOKS the reserve, and reporting the
    // failure without settling it would leave $2.00 of phantom committed spend
    // in the ledger permanently, from a door that can never actually bill. The
    // probe therefore UNDOES its own booking before reporting. It is
    // best-effort: a settle failure must not mask the far more important
    // verdict, so it is logged and the failure still returns.
    if (admitted?.reserveId && admitted?.keyRef && ledger) {
      try {
        await ledger.settle(admitted.keyRef, admitted.reserveId, 0);
      } catch (settleErr) {
        console.error(
          `[money-probe] the cap gate ADMITTED an over-cap probe reservation AND the compensating settle failed ` +
            `(${String(settleErr)}) — ${admitted.keyRef}/${admitted.reserveId} may hold a phantom booking`,
        );
      }
    }
    return { passed: false, failingComponent: 'cap-gate-admitted-over-cap', refusalReason: null };
  } catch (err) {
    const reason = (err as { reason?: unknown })?.reason;
    refusalReason = typeof reason === 'string' ? reason : null;
  }

  if (refusalReason === 'cap-exceeded') {
    return { passed: true, evaluatedUsd: PROBE_EVALUATED_USD, refusalReason: 'cap-exceeded' };
  }
  // Any other refusal reason ⇒ unknown ⇒ NOT ready.
  return {
    passed: false,
    failingComponent: `cap-gate-refused-for-wrong-reason:${refusalReason ?? 'unknown'}`,
    refusalReason,
  };
}
