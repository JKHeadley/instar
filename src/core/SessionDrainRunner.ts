/**
 * SessionDrainRunner — the OWNER-side bounded drain for an active-topic
 * transfer (WS1.2, MULTI-MACHINE-SEAMLESSNESS-SPEC).
 *
 * Executes the receiver half of the `drain` mesh verb: the router (transfer
 * planner) has ordered this machine — the topic's CURRENT owner — to hand the
 * topic to `target`. The runner:
 *
 *   1. Re-validates ownership + the sender's observed epoch, then CASes
 *      active → transferring(target). A stale/replayed drain dies HERE at the
 *      fence (reach ≠ authority — RBAC proved the sender may ask; the CAS
 *      proves the ask still matches reality).
 *   2. Suspends the topic's autonomous run for the move (the REMOTE arm of
 *      WS1.4 — the state file survives, rides the working-set carrier).
 *   3. Waits for the session's turn boundary, bounded by `drainBoundMs`,
 *      checking the emergency stop EVERY poll.
 *   4. On the boundary (or the bound): closes the local session — forced at
 *      the bound, marked `interrupted-mid-task` with ONE honest notice — and
 *      COMPLETES the transfer by landing the target's claim CAS (the FSM
 *      permits a non-target sender to land a claim NAMING the target — the
 *      established router-confirmClaim precedent), so the durable queue's
 *      barrier releases to the new owner exactly at drain completion.
 *   5. On emergency stop: CAS abort-transfer — the topic STAYS HERE, the
 *      sender marks the transfer failed-needs-retry, nothing is left split.
 *
 * The drain BARRIER needs no new machinery: while the record is
 * `transferring`, route() queues inbound (ownership-contention); the claim in
 * step 4 is the release point. The WS1.3 reconciler's transferring-to-me claim
 * is held back by `drainClaimGraceMs` so it backstops a dead-mid-drain owner
 * WITHOUT front-running a live one.
 *
 * Honest bound (named in the side-effects artifact): the spec's full "final
 * context flush durably replicated" release gate is the Track H ledger
 * machinery; today's release point is drain completion, with the target's
 * spawn-time history + working-set fetch carrying the context.
 *
 * All I/O is injected — the sequence is deterministic and unit-testable.
 * P19: one bounded poll loop (drainBoundMs / pollMs), no retries, no timers
 * that outlive run().
 */

import type { OwnershipAction, SessionOwnershipRecord } from './SessionOwnership.js';

export interface DrainRequest {
  /** The topic key being transferred. */
  sessionKey: string;
  /** The machine the topic is moving to. */
  target: string;
  /** The ownership epoch the SENDER observed when planning the transfer. */
  senderObservedEpoch: number;
}

export type DrainStatus =
  | 'drained'                 // clean: turn boundary reached, session closed, claim landed
  | 'drained-interrupted'     // forced at the bound: closed mid-task, claim landed, notice sent
  | 'aborted-emergency-stop'  // emergency stop: transfer aborted, topic stays here
  | 'refused-not-owner'       // this machine does not own the topic
  | 'refused-stale-epoch'     // the sender's observed epoch no longer matches (replay / raced transfer)
  | 'refused-cas-lost';       // could not enter (or exit) transferring — a peer raced us

export interface DrainOutcome {
  status: DrainStatus;
  /** True only when this drain landed the target ownership claim. */
  claimLanded?: boolean;
  /** True when the topic's autonomous run was suspended for the move. */
  autonomousRunSuspended: boolean;
  /** Milliseconds spent waiting for the turn boundary. */
  drainedInMs?: number;
  detail?: string;
}

export interface SessionDrainRunnerDeps {
  selfMachineId: string;
  readOwnership: (sessionKey: string) => SessionOwnershipRecord | null;
  /** The registry CAS (epoch-fenced; legality enforced by the FSM). */
  cas: (
    action: OwnershipAction,
    ctx: { sessionKey: string; sender: string; nonce: string },
  ) => { ok: boolean; reason?: string };
  /** WS1.4 remote arm: suspend the topic's autonomous run, file survives. */
  suspendAutonomousRun: (topic: string, target: string) => { suspended: boolean };
  /** Turn-boundary signal: is the topic's local session quiet (no turn in flight)?
   *  `true` when there is no local session at all — nothing to drain. */
  sessionQuiet: (sessionKey: string) => boolean;
  /** The emergency-stop flag (checked EVERY poll — user safety preempts the move). */
  emergencyStopActive: () => boolean;
  /** Close the topic's local session. `force` at the bound (the session did not
   *  reach a boundary in time); implementations escalate to hard-kill if wedged. */
  terminateSession: (
    sessionKey: string,
    reason: string,
    opts: { force: boolean },
  ) => Promise<{ terminated: boolean; skipped?: string }>;
  /** Stamp the topic's suspended run file `interrupted_mid_task: true` (no-op without a run). */
  markInterrupted: (topic: string) => void;
  /** ONE honest notice for a forced close ("moved to X mid-task — final turn may be partial"). */
  notifyInterrupted: (topic: string, target: string, detail: string) => void;
  audit?: (event: Record<string, unknown>) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  nonce: () => string;
}

export interface SessionDrainRunnerConfig {
  /** Hard bound on the turn-boundary wait (spec: a long reply must not block a transfer). */
  drainBoundMs: number;
  /** Poll cadence inside the bound. */
  pollMs: number;
}

export const DEFAULT_DRAIN_RUNNER_CONFIG: SessionDrainRunnerConfig = {
  drainBoundMs: 30_000,
  pollMs: 1_000,
};

/**
 * How long the WS1.3 reconciler must hold back its transferring-to-me claim so
 * it backstops a dead-mid-drain owner without front-running a live drain:
 * the drain bound plus slack for the close + claim CAS to land.
 */
export const DEFAULT_DRAIN_CLAIM_GRACE_MS = DEFAULT_DRAIN_RUNNER_CONFIG.drainBoundMs + 15_000;

export class SessionDrainRunner {
  private readonly deps: SessionDrainRunnerDeps;
  private readonly cfg: SessionDrainRunnerConfig;

  constructor(deps: SessionDrainRunnerDeps, cfg: Partial<SessionDrainRunnerConfig> = {}) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_DRAIN_RUNNER_CONFIG, ...cfg };
  }

  async run(req: DrainRequest): Promise<DrainOutcome> {
    const d = this.deps;
    const audit = (event: string, detail: Record<string, unknown> = {}) =>
      d.audit?.({ event, sessionKey: req.sessionKey, target: req.target, ...detail });
    const abortForEmergencyStop = (autonomousRunSuspended: boolean): DrainOutcome => {
      const ab = d.cas(
        { type: 'abort-transfer', machineId: d.selfMachineId },
        { sessionKey: req.sessionKey, sender: d.selfMachineId, nonce: d.nonce() },
      );
      audit('drain-aborted-emergency-stop', { abortLanded: ab.ok, casReason: ab.reason });
      return {
        status: 'aborted-emergency-stop',
        autonomousRunSuspended,
        detail: ab.ok ? 'transfer-aborted-topic-stays' : `abort-cas-${ab.reason ?? 'lost'}`,
      };
    };

    // ── 1. Re-validate + fence ────────────────────────────────────────────
    const rec = d.readOwnership(req.sessionKey);
    const resumingOwnDrain =
      rec?.status === 'transferring' && rec.ownerMachineId === d.selfMachineId && rec.transferTo === req.target;
    if (!resumingOwnDrain) {
      if (!rec || rec.status !== 'active' || rec.ownerMachineId !== d.selfMachineId) {
        audit('drain-refused', { reason: 'not-owner', observedStatus: rec?.status ?? 'none' });
        return { status: 'refused-not-owner', autonomousRunSuspended: false };
      }
      if (rec.ownershipEpoch !== req.senderObservedEpoch) {
        // The transfer this drain belongs to no longer matches reality
        // (replayed drain, or ownership moved since the plan) — refuse.
        audit('drain-refused', { reason: 'stale-epoch', observed: rec.ownershipEpoch, sent: req.senderObservedEpoch });
        return { status: 'refused-stale-epoch', autonomousRunSuspended: false };
      }
      const t = d.cas(
        { type: 'transfer', to: req.target, drain: true },
        { sessionKey: req.sessionKey, sender: d.selfMachineId, nonce: d.nonce() },
      );
      if (!t.ok) {
        audit('drain-refused', { reason: 'cas-lost', casReason: t.reason });
        return { status: 'refused-cas-lost', autonomousRunSuspended: false, detail: t.reason };
      }
      audit('drain-started', { epoch: req.senderObservedEpoch });
    } else {
      // A re-delivered drain for the transfer we are ALREADY draining —
      // idempotent resume of the wait loop, no second CAS.
      audit('drain-resumed');
    }

    // ── 2. WS1.4 remote arm: suspend the run for the move ────────────────
    let autonomousRunSuspended = false;
    try {
      autonomousRunSuspended = d.suspendAutonomousRun(req.sessionKey, req.target).suspended;
    } catch {
      // @silent-fallback-ok — reported via the outcome field (false); the run's
      // own stop hook keeps it honest on this machine either way.
    }

    // ── 3. Bounded wait for the turn boundary, emergency stop every poll ─
    const startedAt = d.now();
    let interrupted = false;
    for (;;) {
      if (d.emergencyStopActive()) {
        return abortForEmergencyStop(autonomousRunSuspended);
      }
      if (d.sessionQuiet(req.sessionKey)) break;
      if (d.now() - startedAt >= this.cfg.drainBoundMs) {
        interrupted = true;
        break;
      }
      await d.sleep(this.cfg.pollMs);
    }
    const drainedInMs = d.now() - startedAt;

    // ── 4. Close the local session, complete the transfer ────────────────
    const reason = interrupted
      ? `topic ${req.sessionKey} transferring to ${req.target} — drain bound reached, closing mid-task`
      : `topic ${req.sessionKey} transferring to ${req.target} — turn boundary reached, clean close`;
    let closeSkipped: string | undefined;
    try {
      const res = await d.terminateSession(req.sessionKey, reason, { force: interrupted });
      if (!res.terminated) closeSkipped = res.skipped ?? 'unknown';
    } catch (err) {
      closeSkipped = err instanceof Error ? err.message : String(err);
    }
    // Termination is awaited and may take long enough for the operator's
    // emergency stop to arrive. Recheck at the final authority boundary,
    // immediately before the target claim CAS.
    if (d.emergencyStopActive()) {
      return abortForEmergencyStop(autonomousRunSuspended);
    }
    if (interrupted) {
      try { d.markInterrupted(req.sessionKey); } catch { /* @silent-fallback-ok — marker is best-effort; the notice below is the user-facing record */ }
      try {
        d.notifyInterrupted(req.sessionKey, req.target, `drain bound (${this.cfg.drainBoundMs}ms) reached — final turn may be partial`);
      } catch { /* @silent-fallback-ok — notice failure must not strand the transfer; the audit row below is the durable record */ }
    }

    // Land the target's claim — the owner completing the handoff it was
    // ordered to perform (router-confirmClaim precedent: the FSM checks the
    // claim NAMES the transfer target, not who sent the CAS). This is the
    // barrier release point: the queue stops holding and forwards to the
    // new owner. If the CAS lost, the reconciler's post-grace claim is the
    // backstop — the transfer still completes, just later.
    const claim = d.cas(
      { type: 'claim', machineId: req.target },
      { sessionKey: req.sessionKey, sender: d.selfMachineId, nonce: d.nonce() },
    );
    audit(interrupted ? 'drain-completed-interrupted' : 'drain-completed', {
      drainedInMs, claimLanded: claim.ok, ...(closeSkipped ? { closeSkipped } : {}),
    });
    return {
      status: interrupted ? 'drained-interrupted' : 'drained',
      claimLanded: claim.ok,
      autonomousRunSuspended,
      drainedInMs,
      ...(closeSkipped ? { detail: `close-skipped:${closeSkipped}` } : {}),
    };
  }
}
