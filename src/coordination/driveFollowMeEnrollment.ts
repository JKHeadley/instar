/**
 * WS5.2 (ws52-operator-tap-not-text Part B) — the durable enroll CONSUMER's
 * orchestration: drive ONE delivered account-follow-me mandate through enrollment,
 * fail-closed, single-flight-guarded, with honest single-emission operator
 * surfacing. This is the heart of the connector — the piece whose absence
 * (`onMandateDelivered` had no callers) made the proof stall silently.
 *
 * It is dependency-INJECTED so the risky orchestration logic (the sequence, the
 * fail-closed branches, the "exactly one operator message" surfacing, the
 * no-silent-stall guarantee) is unit-testable without the real EnrollmentWizard,
 * stores, or mesh. The real-dep wiring (the actual wizard / single-flight /
 * outbox / mesh status verb) is mechanical and lands at integration.
 *
 * Invariants enforced here (from the convergence):
 *  - Point-of-use re-verify (bounds+expiry+revocation) BEFORE any enroll (#3).
 *  - Single-flight: a second drive for a LIVE pair is a no-op (#2).
 *  - Honest surfacing: EVERY terminal outcome (login-issued OR failed) produces
 *    exactly one operator message via the outbox (R3.3) — no silent stall.
 *  - Fail-closed: any thrown dependency ⇒ a recorded `failed` + one failure message,
 *    never an unrecorded crash.
 */
import type { AccountFollowMeSingleFlight } from './AccountFollowMeSingleFlight.js';
import type { AccountFollowMeOperatorOutbox } from './AccountFollowMeOperatorOutbox.js';
import { checkDeliveredMandateUsableForEnroll } from './enrollPointOfUseCheck.js';
import { singleFlightKey } from './AccountFollowMeSingleFlight.js';

export interface LoginArtifact {
  verificationUrl: string;
  userCode: string;
  ttlMs: number;
}

export interface DriveEnrollDeps {
  singleFlight: AccountFollowMeSingleFlight;
  outbox: AccountFollowMeOperatorOutbox;
  /** Live revocation oracle (local flag + durable record); a throw ⇒ fail-closed. */
  isRevoked: (mandateId: string) => boolean;
  /** Drive the local re-mint; resolves a LoginArtifact (URL+code, never a token) or throws. */
  startEnrollment: (args: { accountId: string; mandateId: string }) => Promise<LoginArtifact>;
  /** Surface to the operator on the FRONTING machine (fail-closed if no verified topic). Returns delivered?. */
  surfaceToOperator: (msg: {
    kind: 'login-link' | 'failure';
    accountId: string;
    targetMachineId: string;
    login?: LoginArtifact;
    reason?: string;
  }) => Promise<boolean>;
  now: () => number;
  frontingMachineId: string;
  /** This drive's holder token (process/run id) for single-flight ownership. */
  holder: string;
  /** Single-flight claim TTL (dead-holder reclaim window). */
  claimTtlMs: number;
  /** Login-link visibility window written onto the login-issued ledger state. */
  loginTtlMs: number;
}

export interface DriveEnrollInput {
  mandateId: string;
  expiresAt: string;
  bounds: { accountId: string; targetMachineId: string };
  requested: { accountId: string; targetMachineId: string };
  /** A stable id for THIS delivery event (drives outbox idempotency). */
  eventId: string;
}

export type DriveEnrollOutcome =
  | { ok: true; state: 'login-issued'; login: LoginArtifact }
  | { ok: false; state: 'denied' | 'in-flight' | 'failed'; reason: string };

export async function driveFollowMeEnrollment(
  deps: DriveEnrollDeps,
  input: DriveEnrollInput,
): Promise<DriveEnrollOutcome> {
  const key = singleFlightKey(input.requested.accountId, input.requested.targetMachineId);

  // 1. Point-of-use re-verify (#3) — bounds + expiry + LIVE revocation, fail-closed.
  const check = checkDeliveredMandateUsableForEnroll({
    mandateId: input.mandateId,
    expiresAt: input.expiresAt,
    bounds: input.bounds,
    requested: input.requested,
    now: deps.now(),
    isRevoked: deps.isRevoked,
  });
  if (!check.ok) {
    // A denied mandate is NOT an in-flight failure — it never enrolled. No operator
    // spam (a revoked/expired mandate the operator already knows about); just deny.
    return { ok: false, state: 'denied', reason: check.reason };
  }

  // 2. Single-flight (#2) — refuse a duplicate drive for a LIVE pair.
  const claim = deps.singleFlight.tryClaim({
    accountId: input.requested.accountId,
    targetMachineId: input.requested.targetMachineId,
    frontingMachineId: deps.frontingMachineId,
    mandateId: input.mandateId,
    holder: deps.holder,
    ttlMs: deps.claimTtlMs,
  });
  if (!claim.claimed) {
    return { ok: false, state: 'in-flight', reason: 'enrollment already in flight for this pair' };
  }

  // 3. Drive the re-mint. ANY throw ⇒ recorded failed + ONE honest failure message
  //    (the no-silent-stall guarantee — the exact bug this connector fixes).
  let login: LoginArtifact;
  try {
    login = await deps.startEnrollment({ accountId: input.requested.accountId, mandateId: input.mandateId });
  } catch (err) {
    deps.singleFlight.transition(key, 'failed', deps.holder);
    const reason = err instanceof Error ? err.message : 'enrollment drive failed';
    const emit = deps.outbox.claimEmit({ ledgerKey: key, state: 'failed', eventId: input.eventId });
    if (emit.emit) {
      await deps.surfaceToOperator({
        kind: 'failure',
        accountId: input.requested.accountId,
        targetMachineId: input.requested.targetMachineId,
        reason,
      }).catch(() => {/* surfacing failure is itself recorded via the outbox claim; never throw */});
    }
    return { ok: false, state: 'failed', reason };
  }

  // 4. login-issued + ONE login-link message (outbox-deduped across redelivery/restart).
  deps.singleFlight.transition(key, 'login-issued', deps.holder, { ttlMs: deps.loginTtlMs });
  const emit = deps.outbox.claimEmit({ ledgerKey: key, state: 'login-issued', eventId: input.eventId });
  if (emit.emit) {
    await deps.surfaceToOperator({
      kind: 'login-link',
      accountId: input.requested.accountId,
      targetMachineId: input.requested.targetMachineId,
      login,
    }).catch(() => {/* never throw out of the drive; the outbox already recorded the single emit */});
  }
  return { ok: true, state: 'login-issued', login };
}
