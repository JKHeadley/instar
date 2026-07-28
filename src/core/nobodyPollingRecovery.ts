/**
 * MESH-SELF-HEAL G2 — nobody-polling detector + single-claimant recovery (pure core).
 *
 * Spec: docs/specs/MESH-SELF-HEAL-SPEC.md §3.2; build plan: MESH-SELF-HEAL-G2-BUILD.md.
 *
 * The silent-loss backstop. When NO machine is polling Telegram (the 3.5h-incident
 * state — a zombie lease-holder that stopped fetching, the exact live condition on
 * the Mini+Laptop pair 2026-06-27), exactly ONE fit machine must take poll-ownership
 * — never zero (drops), never two (the 409 poll-war).
 *
 * This module is PURE + deterministic (no I/O) so every decision boundary is
 * unit-testable on both sides. It REDUCES over the existing B5 detector
 * (`pollerCount.ts` evaluatePollerCount) — it does NOT reinvent the poll-count fold.
 * It is SIGNAL/decision only; the caller actuates via the existing
 * poll-follows-lease / effectivePollIntent lever and the fenced epoch-CAS.
 *
 * Ships DARK + dryRun-first behind a flag (like G3) — the caller no-ops on a single
 * machine or flag-off.
 */

import type { PollerCountVerdict } from './pollerCount.js';

/** A pool machine's fitness for taking poll-ownership this episode. */
export interface PollClaimMachine {
  machineId: string;
  /**
   * fit = heartbeat-fresh AND advertising pollFresh AND not self-excluded this
   * episode. The caller computes this from the advertised heartbeat booleans;
   * the election only ever considers fit machines (an unfit machine is never a
   * candidate). Self-exclusion (Adv3-F-A) is folded in here so a just-relinquished
   * machine is skipped immediately rather than re-nominated for ~one interval.
   */
  fit: boolean;
}

export interface NobodyPollingClaimInput {
  /** This machine's id. */
  selfMachineId: string;
  /** The B5 verdict over the pool (from evaluatePollerCount / poolPollerVerdict). */
  pollerVerdict: PollerCountVerdict;
  /**
   * True only when a `silence` verdict has PERSISTED across
   * `nobodyPollingConfirmObservations` consecutive fresh evaluator ticks
   * (finding Adv-F9 — a normal handoff gap is a transient silence and must NOT
   * trip a claim). Caller owns the counter; this is the debounced edge.
   */
  silenceConfirmed: boolean;
  /** The F4 preferred-awake machine id, or null if none designated. */
  preferredAwakeMachineId: string | null;
  /** Every pool machine with its fitness (INCLUDING self). */
  machines: PollClaimMachine[];
  /**
   * POSITIVE evidence the outage is GLOBAL (Telegram down for everyone), NOT just
   * local: a fresh, signed heartbeat received from ≥1 live peer that ALSO reports
   * its own poll as failing. "I can't hear any peer" must NEVER set this true
   * (Adv2-F2 — a heartbeat-transport partition is not a global outage). When true,
   * HOLD (do not claim) and route to escalation — claiming can't fix a global
   * outage and would just churn.
   */
  globalOutageEvidence: boolean;
}

export type NobodyPollingAction =
  | 'no-op'            // verdict ok — exactly one poller, nothing to do
  | 'veto-dual'        // verdict dual — claiming into a 2-poller state IS the 409 war
  | 'fail-closed'      // verdict indeterminate — a dark/unknown peer; never claim on a visibility gap
  | 'await-confirm'    // silence not yet persisted across confirmObservations
  | 'hold-global'      // confirmed silence BUT peer-confirmed global outage — escalate, don't claim
  | 'escalate-no-fit'  // confirmed silence, no fit machine can claim — escalate (signal-only)
  | 'claim'            // THIS machine is the single elected claimant — acquire the fenced CAS + actuate
  | 'stand-down';      // another machine is the elected claimant — do nothing, observe

export interface NobodyPollingDecision {
  action: NobodyPollingAction;
  /** The deterministically-elected single claimant (machineId), or null. */
  claimant: string | null;
  /** Should THIS machine actuate (acquire CAS + start polling)? Only true for 'claim'. */
  selfClaims: boolean;
  /** Short machine-readable reason for the audit log. */
  reason: string;
}

/**
 * Deterministic single-claimant election: the F4 preferred-awake machine IF it is
 * itself fit, else the LOWEST-machineId fit machine (finding DC-OQ2). Returns null
 * if no machine is fit. This is the heart of "single-claimant, NOT each-machine-
 * decides" — every machine running this over the same inputs elects the SAME
 * claimant, so there is no split-brain double-claim.
 */
export function electPollClaimant(
  preferredAwakeMachineId: string | null,
  machines: PollClaimMachine[],
): string | null {
  const fit = machines.filter((m) => m.fit).map((m) => m.machineId);
  if (fit.length === 0) return null;
  if (preferredAwakeMachineId !== null && fit.includes(preferredAwakeMachineId)) {
    return preferredAwakeMachineId;
  }
  // Lowest machineId among fit — a stable, partition-independent tiebreak.
  return fit.slice().sort()[0];
}

/**
 * Decide whether THIS machine should claim poll-ownership. Pure; the caller
 * actuates only on `selfClaims` (acquire the fenced epoch-CAS, then run
 * decidePostCasSelfReverify before committing to serve).
 */
export function decideNobodyPollingClaim(
  input: NobodyPollingClaimInput,
): NobodyPollingDecision {
  const {
    selfMachineId, pollerVerdict, silenceConfirmed,
    preferredAwakeMachineId, machines, globalOutageEvidence,
  } = input;

  switch (pollerVerdict) {
    case 'ok':
      return { action: 'no-op', claimant: null, selfClaims: false, reason: 'one-poller-ok' };
    case 'dual':
      // Claiming into a 2-poller state is exactly the 409 war G2 exists to prevent.
      return { action: 'veto-dual', claimant: null, selfClaims: false, reason: 'dual-poll-veto-claim' };
    case 'indeterminate':
      // A dark/unknown peer — the count can't be confirmed. Never claim on a gap.
      return { action: 'fail-closed', claimant: null, selfClaims: false, reason: 'visibility-gap-no-claim' };
    case 'silence':
      break; // handled below
    default: {
      // Exhaustiveness guard — an unknown verdict is treated as a visibility gap.
      const _never: never = pollerVerdict;
      return { action: 'fail-closed', claimant: null, selfClaims: false, reason: `unknown-verdict:${String(_never)}` };
    }
  }

  // verdict === 'silence'
  if (!silenceConfirmed) {
    // Transient silence (a normal handoff gap) — wait for the debounce.
    return { action: 'await-confirm', claimant: null, selfClaims: false, reason: 'silence-not-yet-confirmed' };
  }
  if (globalOutageEvidence) {
    // Peer-confirmed global outage — claiming can't fix it; escalate instead.
    return { action: 'hold-global', claimant: null, selfClaims: false, reason: 'global-outage-peer-confirmed' };
  }
  const claimant = electPollClaimant(preferredAwakeMachineId, machines);
  if (claimant === null) {
    // Confirmed silence but nobody is fit to take over — escalate (signal-only).
    return { action: 'escalate-no-fit', claimant: null, selfClaims: false, reason: 'no-fit-machine-to-claim' };
  }
  if (claimant === selfMachineId) {
    const why = claimant === preferredAwakeMachineId ? 'preferred-awake-fit' : 'lowest-id-fit';
    return { action: 'claim', claimant, selfClaims: true, reason: why };
  }
  return { action: 'stand-down', claimant, selfClaims: false, reason: 'another-machine-is-claimant' };
}

export interface PostCasSelfReverifyInput {
  /**
   * This machine's OWN live poll-success freshness, read AFTER winning the CAS
   * (current + local — NOT the heartbeat-cadence-lagging advertised boolean the
   * election used). Adv2-F1: CAS-win is necessary but not sufficient.
   */
  localPollSucceededFresh: boolean;
}

export type PostCasAction = 'serve' | 'relinquish-self-exclude';

export interface PostCasSelfReverifyDecision {
  /** Commit to serving (start polling)? */
  commit: boolean;
  action: PostCasAction;
  /**
   * When false: the caller must relinquish the won epoch (signed tombstone +
   * the G1 quiesce) AND advertise pollFresh:false + selfExcludedThisEpisode in
   * its next heartbeat so peers skip it immediately (Adv3-F-A).
   */
  reason: string;
}

/**
 * After winning the fenced CAS, re-verify this machine's OWN current poll-success
 * freshness before committing to serve. On self-unfit, relinquish + self-exclude
 * (the immediate self-demotion that stops peers re-nominating the lagged set).
 */
export function decidePostCasSelfReverify(
  input: PostCasSelfReverifyInput,
): PostCasSelfReverifyDecision {
  if (input.localPollSucceededFresh) {
    return { commit: true, action: 'serve', reason: 'self-reverified-fit' };
  }
  return { commit: false, action: 'relinquish-self-exclude', reason: 'self-unfit-after-cas' };
}

/**
 * G2 soak/episode ledger — evaluable observability (mirrors the G3 close-the-loop
 * requirement: a dark feature must record evidence it can be promoted on). Counts
 * episodes + each decision-class transition. SIGNAL only.
 */
export interface NobodyPollingLedgerSummary {
  episodes: number;          // distinct confirmed-silence episodes entered
  claimsWonBySelf: number;   // this machine elected + claimed
  standDowns: number;        // another machine was claimant
  selfExclusions: number;    // CAS-won then self-unfit → relinquished
  vetoesDual: number;        // claim vetoed because dual-poll
  failClosed: number;        // no claim due to visibility gap
  holdGlobal: number;        // held due to peer-confirmed global outage
  escalationsNoFit: number;  // confirmed silence, nobody fit
  firstAt: string | null;
  lastAt: string | null;
}

export class NobodyPollingLedger {
  private s: NobodyPollingLedgerSummary = {
    episodes: 0, claimsWonBySelf: 0, standDowns: 0, selfExclusions: 0,
    vetoesDual: 0, failClosed: 0, holdGlobal: 0, escalationsNoFit: 0,
    firstAt: null, lastAt: null,
  };

  /** Record a claim decision. `nowIso` injected (callers pass a real timestamp). */
  recordClaim(decision: NobodyPollingDecision, nowIso: string): void {
    let counted = true;
    switch (decision.action) {
      case 'claim': this.s.claimsWonBySelf += 1; break;
      case 'stand-down': this.s.standDowns += 1; break;
      case 'veto-dual': this.s.vetoesDual += 1; break;
      case 'fail-closed': this.s.failClosed += 1; break;
      case 'hold-global': this.s.holdGlobal += 1; break;
      case 'escalate-no-fit': this.s.escalationsNoFit += 1; break;
      // no-op / await-confirm are non-events for the soak metric.
      default: counted = false;
    }
    if (!counted) return;
    if (this.s.firstAt === null) this.s.firstAt = nowIso;
    this.s.lastAt = nowIso;
  }

  /** Record entering a NEW confirmed-silence episode (caller dedups the edge). */
  recordEpisode(nowIso: string): void {
    this.s.episodes += 1;
    if (this.s.firstAt === null) this.s.firstAt = nowIso;
    this.s.lastAt = nowIso;
  }

  /** Record a post-CAS self-exclusion (relinquished after winning). */
  recordSelfExclusion(nowIso: string): void {
    this.s.selfExclusions += 1;
    this.s.lastAt = nowIso;
  }

  summary(): NobodyPollingLedgerSummary {
    return { ...this.s };
  }
}

/** Process-wide shared G2 ledger (mirrors sharedG3SoakLedger). */
export const sharedG2NobodyPollingLedger = new NobodyPollingLedger();
