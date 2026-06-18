/**
 * WS5.2 (ws52-operator-tap-not-text Part B, FD5) — the durable CONSUMER sweep: the
 * missing caller. Convergence #1 found `AccountFollowMeService.onMandateDelivered`
 * had NO callers — a delivered mandate just sat in the store and the proof stalled.
 * This sweep (run on boot + on a tick) is the caller: it walks the delivered-mandate
 * store and drives each not-yet-completed mandate through `driveFollowMeEnrollment`
 * (which itself enforces point-of-use re-verify, single-flight, and honest
 * surfacing). Restart-safe by construction (the store + single-flight ledger are
 * durable), so an offline-at-delivery target enrolls when it returns.
 *
 * Dependency-injected + pure-orchestration so it is unit-testable without the real
 * store/wizard/mesh. The server-side scheduling (boot-sweep + tick) and the real-dep
 * wiring are mechanical and land at integration.
 *
 * Skip rule (the freshness guard): a mandate whose single-flight state is already
 * `completed` is DONE — never re-driven (re-driving would re-mint). An
 * `enroll-in-flight`/`login-issued` pair is LIVE — left to its holder (driveFn's
 * own single-flight would refuse it anyway, but skipping avoids the wasted call).
 * `failed`/absent ⇒ driven (fresh or retry).
 */
import { singleFlightKey } from './AccountFollowMeSingleFlight.js';
import type { AccountFollowMeSingleFlight } from './AccountFollowMeSingleFlight.js';
import type { DriveEnrollInput, DriveEnrollOutcome } from './driveFollowMeEnrollment.js';

export interface DeliveredForSweep {
  mandateId: string;
  expiresAt: string;
  bounds: { accountId: string; targetMachineId: string };
}

export interface ConsumerSweepDeps {
  /** Delivered mandates, mapped to the minimal sweep shape (from DeliveredMandateStore.list + readFollowMeBounds). */
  listDelivered: () => DeliveredForSweep[];
  singleFlight: AccountFollowMeSingleFlight;
  /** driveFollowMeEnrollment, pre-bound to its deps. */
  drive: (input: DriveEnrollInput) => Promise<DriveEnrollOutcome>;
  /** Stable per-sweep event id base (e.g. a sweep timestamp/run id) for outbox idempotency. */
  eventIdFor: (mandateId: string) => string;
  log?: (m: string) => void;
}

export interface SweepResult {
  considered: number;
  driven: number;
  skippedCompleted: number;
  skippedInFlight: number;
  outcomes: Array<{ mandateId: string; outcome: DriveEnrollOutcome }>;
}

export async function runFollowMeConsumerSweep(deps: ConsumerSweepDeps): Promise<SweepResult> {
  const delivered = deps.listDelivered() || [];
  const result: SweepResult = {
    considered: delivered.length,
    driven: 0,
    skippedCompleted: 0,
    skippedInFlight: 0,
    outcomes: [],
  };

  for (const d of delivered) {
    if (!d || !d.bounds || !d.bounds.accountId || !d.bounds.targetMachineId) continue;
    const key = singleFlightKey(d.bounds.accountId, d.bounds.targetMachineId);
    const rec = deps.singleFlight.get(key);
    if (rec && rec.state === 'completed') {
      result.skippedCompleted++;
      continue; // already enrolled — never re-drive (would re-mint)
    }
    if (deps.singleFlight.isActive(key)) {
      result.skippedInFlight++;
      continue; // a live enroll-in-flight/login-issued is owned by its holder
    }
    // fresh / failed / absent → drive it (driveFn re-verifies + claims single-flight)
    const outcome = await deps.drive({
      mandateId: d.mandateId,
      expiresAt: d.expiresAt,
      bounds: d.bounds,
      requested: { accountId: d.bounds.accountId, targetMachineId: d.bounds.targetMachineId },
      eventId: deps.eventIdFor(d.mandateId),
    });
    result.driven++;
    result.outcomes.push({ mandateId: d.mandateId, outcome });
    deps.log?.(`[follow-me-sweep] drove ${d.mandateId} → ${outcome.state}`);
  }
  return result;
}
