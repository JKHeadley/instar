/**
 * AgentIdentityReconciler — decide, safely, which identity is canonical, and repair to it.
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §3.
 * Constitution: "Know Your Principal — An Unverified Identity Is a Guess"; "No Silent Degradation".
 *
 * ── THE ONE THING THAT MATTERS ───────────────────────────────────────────────────────────
 * Repairing to the WRONG identity takes the agent off the network. So every uncertain branch
 * REFUSES and reports. There is no branch that guesses, and no branch that picks a winner on
 * a tiebreak. That is why this module returns a DECISION rather than performing a repair: the
 * caller cannot accidentally act on an unresolved one.
 *
 * ── LINEAGE IS EVIDENCE, NOT AUTHORITY ───────────────────────────────────────────────────
 * `minted-standalone` provenance is trustworthy only for identities created AFTER the mint
 * guard exists, because a compromised host or an older binary can self-sign a false claim. So
 * lineage orders a set of cooperating machines running current code; anything else — including
 * every identity that predates the record, which is the live 2026-08-19 split — routes to the
 * operator.
 *
 * Explicitly NOT used as tiebreakers, though each looks persuasive:
 *   • durable prevalence (a long-running wrong identity accumulates the same weight),
 *   • peer majority (two machines cloned from one mistake outvote the correct one),
 *   • the lease holder (it may BE the diverged machine — it was, in the live incident).
 */

import type { IdentityProvenance } from './AgentIdentityHandover.js';

export interface IdentityCandidate {
  fingerprint: string;
  /** Machines publishing this identity, for the operator-facing description. */
  machineNames: string[];
  /** Provenance, when the identity carries a record. Absent → `unknown-origin`. */
  provenance?: IdentityProvenance;
  /** Earliest known first-seen, used only to DESCRIBE candidates, never to choose between them. */
  firstSeen?: string;
}

export type ReconcileDecision =
  | { action: 'no-op'; reason: 'single-identity' }
  | { action: 'repair'; canonicalFingerprint: string; basis: 'lineage'; repairMachines: string[] }
  | {
      action: 'ask-operator';
      reason: 'no-attested-root' | 'multiple-roots' | 'unattested-version-present';
      candidates: OperatorCandidate[];
    };

/** A candidate rendered for a human: description first, fingerprint as supporting detail. */
export interface OperatorCandidate {
  fingerprint: string;
  /** Plain-language description — this is what the operator actually chooses between. */
  description: string;
  machineNames: string[];
}

/**
 * Decide what to do about a set of observed identities.
 *
 * Pure. Returns a decision; performs nothing.
 */
export function decideReconciliation(input: {
  agentName: string;
  candidates: IdentityCandidate[];
  /** instar versions this build trusts to have produced honest provenance. */
  attestedVersions?: (v: string) => boolean;
}): ReconcileDecision {
  const candidates = input.candidates;
  if (candidates.length <= 1) return { action: 'no-op', reason: 'single-identity' };

  const attested = input.attestedVersions ?? (() => true);

  // Any candidate whose provenance cannot be trusted poisons the LINEAGE route for the whole
  // set — not just for itself. A root that "wins" only because a rival could not be attested
  // is not a decision, it is a default.
  const unattested = candidates.filter((c) => !c.provenance || !attested(c.provenance.producedBy));
  if (unattested.length > 0) {
    return {
      action: 'ask-operator',
      reason: candidates.every((c) => !c.provenance) ? 'no-attested-root' : 'unattested-version-present',
      candidates: candidates.map(describe),
    };
  }

  const roots = candidates.filter((c) => c.provenance?.origin === 'minted-standalone');
  if (roots.length === 0) {
    return { action: 'ask-operator', reason: 'no-attested-root', candidates: candidates.map(describe) };
  }
  if (roots.length > 1) {
    // Two machines each claiming to be an origin is a genuine ambiguity, not a tiebreak.
    return { action: 'ask-operator', reason: 'multiple-roots', candidates: candidates.map(describe) };
  }

  const canonical = roots[0];
  return {
    action: 'repair',
    canonicalFingerprint: canonical.fingerprint,
    basis: 'lineage',
    repairMachines: candidates
      .filter((c) => c.fingerprint !== canonical.fingerprint)
      .flatMap((c) => c.machineNames),
  };
}

/** Describe a candidate in the terms an operator can actually weigh. */
function describe(c: IdentityCandidate): OperatorCandidate {
  const where = c.machineNames.length === 1 ? c.machineNames[0] : c.machineNames.join(' and ');
  const since = c.firstSeen ? ` since ${c.firstSeen.slice(0, 10)}` : '';
  const origin = c.provenance
    ? c.provenance.origin === 'minted-standalone'
      ? ', created as the original'
      : ', received when that machine joined'
    : ', origin unrecorded';
  return {
    fingerprint: c.fingerprint,
    description: `The identity used by ${where}${since}${origin}`,
    machineNames: c.machineNames,
  };
}

export type OperatorChoiceResult =
  | { accepted: true; canonicalFingerprint: string; repairMachines: string[] }
  | { accepted: false; reason: 'unknown-fingerprint' | 'not-a-candidate' | 'cancelled' };

/**
 * Bind an operator's choice to the exact candidate set they were shown.
 *
 * A choice naming something that was not on offer is REFUSED rather than interpreted — that is
 * the difference between a decision and a guess about a decision.
 */
export function applyOperatorChoice(input: {
  candidates: OperatorCandidate[];
  /** The fingerprint the operator's selected option carries. Empty/absent = cancelled. */
  chosenFingerprint: string | null;
}): OperatorChoiceResult {
  if (!input.chosenFingerprint) return { accepted: false, reason: 'cancelled' };
  const match = input.candidates.find((c) => c.fingerprint === input.chosenFingerprint);
  if (!match) return { accepted: false, reason: 'not-a-candidate' };
  return {
    accepted: true,
    canonicalFingerprint: match.fingerprint,
    repairMachines: input.candidates
      .filter((c) => c.fingerprint !== match.fingerprint)
      .flatMap((c) => c.machineNames),
  };
}

/** The plain restatement the operator confirms against — never a bare yes. */
export function renderChoiceConfirmation(input: {
  agentName: string;
  chosen: OperatorCandidate;
  losing: OperatorCandidate[];
}): string {
  const losingMachines = input.losing.flatMap((c) => c.machineNames);
  return (
    `You're choosing: ${input.chosen.description.toLowerCase()}.\n\n` +
    `What happens: ${losingMachines.join(' and ')} ` +
    `${losingMachines.length === 1 ? 'is' : 'are'} changed to use that identity instead. ` +
    `Their current identity is kept as a backup, so this is reversible.\n\n` +
    `What does NOT happen: the old identity stays registered on the relay — clearing that ` +
    `needs separate work — and every machine keeps its own machine keys, which are unaffected.`
  );
}
