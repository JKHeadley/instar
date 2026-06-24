/**
 * GAP-B commitment-evidence backstop — the pure qualifying + agreement predicate.
 *
 * Spec: docs/specs/autonomous-registration-guarantee.md (Part B + Frontloaded
 * Decisions D1/D2/D7/D8).
 *
 * The reaper revives a REGISTERED autonomous run from its per-topic state file.
 * An UNregistered-but-actively-working run (operator said "go autonomous" but the
 * skill never wrote the state file) has no state file → today it dies at the
 * age-limit reap. This module is the BACKSTOP: it recognizes an independent
 * live-work signal — a FRESH open agent-commitment for the topic, CORROBORATED by
 * a recent user message — and (when armed, dark by default) lets the existing
 * revival machinery keep the run alive.
 *
 * This file holds ONLY the deterministic predicates (D1 freshness, D2 qualifying
 * set, D8 agreement). The wiring (the dark-gate, the injection, the Part A
 * surface, the drain-time re-check) lives at the server callsite. Extracting the
 * predicate here makes D1/D2/D7/D8 unit-testable against a REAL CommitmentTracker
 * with no server boot — and guarantees the enqueue-time check and the drain-time
 * re-check (D9) compute the IDENTICAL verdict (they call this same function), so
 * they can never disagree.
 *
 * Signal vs Authority: this returns a boolean SIGNAL. The authority that decides
 * revival remains the unchanged `evidenceEligible`/drainer. No new WorkEvidence
 * enum value; provenance rides the reason tag + the reap-log `evidenceSource`.
 */

import type { Commitment } from '../monitoring/CommitmentTracker.js';

/**
 * Part D (spec: autonomous-registration-guarantee.md) — the pure inbound-user-
 * message recency predicate over a topic's message-history tail. Extracted here
 * so it is unit-testable against real TelegramAdapter.getTopicHistory output
 * WITHOUT a server boot, and shared by every `recentUserMessage` consumer (the
 * ReapGuard/SessionReaper deps AND the GAP-B D8 agreement check) so KEEP and
 * eligibility compute the identical truth.
 *
 * An inbound USER message = `fromUser === true` (NOT an agent/system echo).
 * Freshness = its `timestamp` within `withinMs`. History is oldest→newest, so the
 * newest user entry (the first hit scanning backwards) is the verdict. A
 * non-parseable timestamp is skipped (never a false positive). Returns false on
 * an empty / user-message-free history. Pure — the server callsite wraps the
 * getTopicHistory call in its own try/catch (D7 fail-open).
 */
export interface RecencyLogEntry {
  fromUser: boolean;
  timestamp: string;
}

export function recentUserMessageFromHistory(
  history: readonly RecencyLogEntry[],
  withinMs: number,
  now: number = Date.now(),
): boolean {
  const cutoff = now - withinMs;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry.fromUser) continue; // skip agent/system echoes
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) continue;
    // The first USER entry scanning backwards is the NEWEST user message — its
    // recency is the verdict (every earlier user entry is older).
    return ts >= cutoff;
  }
  return false;
}

/**
 * Local-receipt timestamp (ms) of the NEWEST user message in `history`, or null
 * when there is none / none parses. SAME source as `recentUserMessageFromHistory`
 * so the Part E freshest-interaction veto (post-transfer-closeout-correctness)
 * shares the basis the `recent-user-message` KEEP-guard already uses (local-receipt
 * clock). Used to decide whether a pre-move "recent" message predates the liveness
 * snapshot.
 */
export function recentUserMessageAtFromHistory(
  history: readonly RecencyLogEntry[],
): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry.fromUser) continue;
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) continue;
    return ts; // newest user message scanning backwards
  }
  return null;
}

/** The minimal slice of CommitmentTracker this predicate reads. */
export interface GapBCommitmentSource {
  /** Active commitments bound to a topic (pending/verified/violated, not expired). */
  getActiveByTopicId(topicId: number): Commitment[];
}

export interface GapBQualifyDeps {
  /** This machine's mesh identity, for the D2 local-origin filter. May be absent
   *  (single-machine / pre-mesh) — then no commitment is excluded on origin. */
  ownMachineId?: string;
  /** D1 freshness horizon on `createdAt` (ms). */
  freshCommitmentWindowMs: number;
  /** D8 agreement window — the SAME `recentUserMessage(topic, window)` predicate
   *  ReapGuard's commitment KEEP uses (the staleCommitmentWindowMs / 8h horizon). */
  staleCommitmentWindowMs: number;
  /** D8 corroboration: a recent INBOUND USER message on the topic within window.
   *  Shared with ReapGuard's dep so KEEP and eligibility cannot disagree. */
  recentUserMessage: (topicId: number, withinMs: number) => boolean;
  /** Wall clock (injected for testability). Default Date.now. */
  now?: () => number;
}

/**
 * D2 qualifying-commitment predicate (the per-commitment half).
 *
 * A commitment counts as live-work evidence only if ALL hold:
 *  - `status === 'pending'` (NOT verified/violated — a violated commitment is a
 *    FAILING session, not a working one);
 *  - agent-driven: `owner === 'agent'` (default), OR `owner === 'user'` with
 *    `blockedOn` ∈ {none, undefined} — a commitment WAITING on the user
 *    (`blockedOn` ∈ {user-input, user-authorization}) is the opposite of an
 *    active autonomous run and is excluded;
 *  - not beacon-paused and not beacon-suppressed;
 *  - local-origin: `originMachineId` is this machine or absent (a replicated peer
 *    commitment is advisory data, never revival authority);
 *  - D1 freshness: `createdAt` within `freshCommitmentWindowMs` — `createdAt` ONLY
 *    (no `updatedAt` exists; bookkeeping/beacon timestamps must NOT refresh
 *    freshness — a 3-day promise a beacon pinged 5min ago is not a live session).
 */
export function commitmentQualifies(
  c: Commitment,
  deps: Pick<GapBQualifyDeps, 'ownMachineId' | 'freshCommitmentWindowMs' | 'now'>,
): boolean {
  if (c.status !== 'pending') return false;
  const owner = c.owner ?? 'agent';
  const blockedOn = c.blockedOn ?? 'none';
  const agentDriven = owner === 'agent' || (owner === 'user' && blockedOn === 'none');
  if (!agentDriven) return false;
  if (c.beaconPaused || c.beaconSuppressed) return false;
  if (c.originMachineId && deps.ownMachineId && c.originMachineId !== deps.ownMachineId) {
    return false;
  }
  const nowMs = (deps.now ?? Date.now)();
  const createdMs = Date.parse(c.createdAt);
  if (!Number.isFinite(createdMs) || createdMs < nowMs - deps.freshCommitmentWindowMs) {
    return false;
  }
  return true;
}

/**
 * The full GAP-B eligibility verdict for a topic (D1/D2 + D8 agreement).
 *
 * True iff (a) at least one qualifying commitment exists for the topic (D1/D2),
 * AND (b) there is a recent user message within the stale-commitment window (D8 —
 * the SAME corroboration ReapGuard's commitment KEEP uses, so KEEP and
 * eligibility AGREE; without this the 2026-06-13 13-session reap/revive loop
 * returns). Fail-open (D7): any read throwing ⇒ false (no injection), never a
 * spurious eligibility.
 */
export function gapBEligibleForTopic(
  topicId: number,
  source: GapBCommitmentSource,
  deps: GapBQualifyDeps,
): boolean {
  try {
    const qualifies = source
      .getActiveByTopicId(topicId)
      .some((c) => commitmentQualifies(c, deps));
    if (!qualifies) return false;
    // D8 AGREEMENT — non-negotiable. A commitment that would NOT keep the session
    // alive (no recent user message) cannot revive it either.
    return deps.recentUserMessage(topicId, deps.staleCommitmentWindowMs);
  } catch {
    // @silent-fallback-ok — D7: a throwing tracker/predicate contributes NOTHING;
    // the reap proceeds exactly as today (no injection, no revive).
    return false;
  }
}

/** Dark-gate posture for the Part B injection (D5), resolved from config. */
export interface GapBInjectionGate {
  /** True only when `monitoring.resumeQueue.commitmentEvidence.enabled === true`.
   *  Omitted ⇒ OFF on BOTH fleet AND dev (the containment). */
  armed: boolean;
  /** dryRun defaults TRUE when armed: logs "would inject" without tagging the
   *  candidate (the dark soak proving KEEP/eligibility agree before evidence
   *  flows). Only `armed && !dryRun` actually injects. */
  dryRun: boolean;
}

/**
 * Resolve the Part B dark-gate from the resumeQueue config block (D5).
 * `enabled` MUST be an explicit `true` — absence/false ⇒ disarmed (no injection
 * on fleet OR dev). `dryRun` defaults true when armed.
 */
export function resolveGapBInjectionGate(cfg?: {
  enabled?: boolean;
  dryRun?: boolean;
}): GapBInjectionGate {
  const armed = cfg?.enabled === true;
  return { armed, dryRun: cfg?.dryRun !== false };
}

/** The full reaped-session decision: did GAP-B evidence fire, and does it INJECT? */
export interface GapBInjectionDecision {
  /** The qualifying-commitment + D8 verdict fired (drives the Part A surface,
   *  even in dryRun — the surface exists to make the unregistered run visible). */
  fired: boolean;
  /** The LIVE injection switch: `fired && armed && !dryRun`. Only this tags the
   *  candidate + the reap-log. dryRun logs the verdict but injects nothing. */
  inject: boolean;
}

/**
 * Compute the reaped-session GAP-B decision. Pinned to the SAME branch the
 * state-file source uses: an `age-limit` reap whose per-topic state file is
 * ABSENT (`stateFilePresent === false` — a registered run is handled upstream by
 * AGE_LIMIT_ACTIVE_RUN_REASON). When disarmed, returns a strict no-op
 * `{fired:false, inject:false}` (the dark-default containment: no injection ⇒ no
 * revival ⇒ the 2026-06-13 loop is structurally impossible while dark).
 *
 * `eligible` is the precomputed `gapBEligibleForTopic` verdict (kept a parameter
 * so the caller can short-circuit the cost when disarmed, and so this stays a
 * pure decision function over booleans).
 */
export function decideGapBInjection(input: {
  gate: GapBInjectionGate;
  reason: string;
  stateFilePresent: boolean;
  eligible: boolean;
}): GapBInjectionDecision {
  if (!input.gate.armed) return { fired: false, inject: false };
  if (input.reason !== 'age-limit') return { fired: false, inject: false };
  if (input.stateFilePresent) return { fired: false, inject: false };
  if (!input.eligible) return { fired: false, inject: false };
  return { fired: true, inject: !input.gate.dryRun };
}
