/**
 * strandedTopicDecision — the PURE, unit-testable decision core of the
 * StrandedTopicSentinel (spec docs/specs/stranded-inbound-self-heal.md).
 *
 * A topic is STRANDED when its durable ownership record names a machine that is
 * online-by-heartbeat but, persistently across rich beats, cannot serve the
 * topic's channel — quota-walled (`quotaState.blocked === true`, channel-
 * independent) OR adapter-disconnected (`machineServesChannel(...) === 'no'`).
 * Inbound for that topic routes to the owner that cannot serve it, so it is
 * silently dead while outbound still flows from a healthy lease-holder.
 *
 * This module computes the strand verdict ONLY. It mutates nothing: no
 * ownership CAS, no pin write, no session kill. Fail-closed on EVERY
 * uncertainty (missing field, stale beat, underivable scope, pool view
 * unavailable) — an uncertainty can NEVER manufacture a strand, it routes to
 * SKIP. The quota arm carries detection on its own when the adapter arm skips.
 *
 * Signal-vs-authority: pure read + a verdict object. No authority to misuse.
 */

import type { SessionOwnershipRecord } from '../core/SessionOwnership.js';
import type { MachineCapacity } from '../core/types.js';
import {
  machineServesChannel,
  type ChannelScope,
} from '../core/machineServesChannel.js';

/** The reason an owner cannot serve a stranded topic. */
export type StrandReason = 'quota' | 'adapter';

/** One stranded topic in a tick's verdict. */
export interface StrandedTopic {
  /** Ownership record session key (== the topic key). */
  sessionKey: string;
  /** The machine that owns it but cannot serve it. */
  ownerMachineId: string;
  /** Which arm fired. */
  reason: StrandReason;
  /** Epoch-ms of the FIRST qualifying beat for this topic (the dwell anchor). */
  strandedSince: number;
  /** Owner's last-rich-heartbeat age (ms) at evaluation — for staleness disclosure. */
  ownerBeatAgeMs?: number;
  /** Whether a healthy peer could serve this topic's channel (NOT a failover-safe target). */
  servablePeerExists: boolean;
}

/** Config knobs for the decision (defaults applied by the sentinel). */
export interface StrandedDecisionConfig {
  /** The unable-to-serve condition must hold ≥ this span across ≥2 beats. */
  dwellMs: number;
  /** A beat older than this is not a genuine rich beat → fail-closed (skip). */
  freshnessBoundMs: number;
}

/** Per-tick inputs to the pure decision. */
export interface StrandedDecisionInput {
  /** All known ownership records (the in-memory `all()` scan). */
  records: SessionOwnershipRecord[];
  /** The replicated machine-pool capacities (in-memory view). */
  capacities: MachineCapacity[];
  /** This machine's id. */
  selfMachineId: string;
  /** Whether this machine holds the serving lease (sole-actor gate). */
  holdsLease: boolean;
  /** The previous tick's per-topic strandedSince map (sessionKey → first-beat ms). */
  prevStrandedSince: Record<string, number>;
  /** Wall clock. */
  now: number;
  cfg: StrandedDecisionConfig;
  /**
   * Resolve a topic's ChannelScope from its owning adapter binding. Returns
   * undefined when the scope can't be fully derived (the common Telegram case —
   * see the spec's honesty note) → the adapter arm SKIPs and the quota arm
   * carries detection. Optional: absent ⇒ the adapter arm never qualifies.
   */
  resolveScope?: (sessionKey: string) => ChannelScope | undefined;
}

/** The pure decision's output. */
export interface StrandedDecisionResult {
  /** The topics stranded THIS tick (already dwell-qualified). */
  strandedSet: StrandedTopic[];
  /** Count of online non-self owners SKIPPED because rich fields were missing/unparseable. */
  cantAssessCount: number;
  /**
   * The reconciled strandedSince map to carry into the next tick. A key that did
   * NOT re-qualify this tick (owner offline / record released / scope underivable)
   * is DELETED — never left to resume counting later (spec step 2 reconciliation).
   */
  nextStrandedSince: Record<string, number>;
}

/** Is this owner's rich beat genuine (present + fresh)? */
function richBeatAgeMs(cap: MachineCapacity, now: number): number | undefined {
  if (!cap.routerReceivedAt) return undefined;
  const t = Date.parse(cap.routerReceivedAt);
  if (!Number.isFinite(t)) return undefined;
  return now - t;
}

/**
 * The pure strand evaluation for one tick. Synchronous, LLM-free, no I/O.
 *
 * Predicate per `active`, non-self-owned record:
 *   owner online
 *   AND ( quota arm: quotaState.blocked === true   [channel-independent]
 *         OR adapter arm: machineServesChannel(servesChannels, scope) === 'no'
 *                         ['unknown'/undefined-scope ⇒ SKIP that arm] )
 *   AND the condition has held ≥2 consecutive rich beats spanning ≥ dwellMs.
 *
 * Early no-op: < 2 machines OR !holdsLease ⇒ empty (and the map is dropped).
 */
export function evaluateStrandedTopics(
  input: StrandedDecisionInput,
): StrandedDecisionResult {
  const { records, capacities, selfMachineId, holdsLease, prevStrandedSince, now, cfg } = input;

  // Early no-op gates (spec step 1). A single-machine agent can't strand on a
  // peer; a non-lease-holder is not the sole actor. Drop the dwell map so a
  // demotion/scale-down doesn't carry stale anchors.
  if (capacities.length < 2 || !holdsLease) {
    return { strandedSet: [], cantAssessCount: 0, nextStrandedSince: {} };
  }

  const capById = new Map<string, MachineCapacity>();
  for (const c of capacities) capById.set(c.machineId, c);

  const strandedSet: StrandedTopic[] = [];
  const nextStrandedSince: Record<string, number> = {};
  let cantAssessCount = 0;

  for (const rec of records) {
    // Only active, peer-owned records are candidates.
    if (rec.status !== 'active') continue;
    if (rec.ownerMachineId === selfMachineId) continue;

    const owner = capById.get(rec.ownerMachineId);
    // Unknown owner / not in the pool view → can't assess → skip (fail-closed).
    if (!owner) continue;
    // A dead owner is the existing Case C's job; this sentinel only covers the
    // online-but-unable gap.
    if (!owner.online) continue;

    // Require a genuine rich beat: present + fresh. A stale/undecodable beat
    // fails closed (skip) and does NOT count toward the dwell.
    const beatAgeMs = richBeatAgeMs(owner, now);
    if (beatAgeMs === undefined || beatAgeMs > cfg.freshnessBoundMs) continue;

    // ── Arm (a): quota — channel-independent, the dominant incident case. ──
    const quotaArm = owner.quotaState?.blocked === true;

    // ── Arm (b): adapter — best-effort, channel-specific. ──
    let adapterArm = false;
    // A missing servesChannels on an online owner is the anti-blind-spot case:
    // we cannot evaluate the adapter arm. If the quota arm ALSO can't fire
    // (quotaState absent/undecided), this owner is genuinely unassessable.
    const servesPresent = owner.servesChannels !== undefined;
    let armBlind = false;
    if (input.resolveScope) {
      const scope = input.resolveScope(rec.sessionKey);
      if (scope === undefined) {
        // Underivable scope ⇒ SKIP this arm (not a strand).
      } else {
        const serve = machineServesChannel(owner.servesChannels, scope);
        if (serve === 'no') adapterArm = true;
        else if (serve === 'unknown') {
          // 'unknown' (sparse/absent servesChannels) ⇒ SKIP this arm.
          if (!servesPresent) armBlind = true;
        }
        // 'yes' ⇒ owner can serve on this arm → not stranded here.
      }
    }

    const unableToServe = quotaArm || adapterArm;

    if (!unableToServe) {
      // Anti-blind-spot: an online owner we could NOT assess at all — quota
      // undecided AND the adapter arm blinded by a missing servesChannels —
      // increments the can't-assess count (spec step 4). A topic with a usable
      // 'yes' or a derivable scope is genuinely assessed (not blind).
      const quotaUndecided = owner.quotaState === undefined;
      if (quotaUndecided && armBlind) cantAssessCount++;
      continue;
    }

    // ── Persistence (dwell) — anchor on the FIRST qualifying beat. ──
    const prevSince = prevStrandedSince[rec.sessionKey];
    const strandedSince = typeof prevSince === 'number' ? prevSince : now;
    nextStrandedSince[rec.sessionKey] = strandedSince;

    // The condition must have held ≥ dwellMs (which, given the ≥1 prior beat that
    // set the anchor, spans ≥2 consecutive rich beats). A first-beat strand has
    // dwell 0 < dwellMs → recorded in the map but NOT yet emitted.
    if (now - strandedSince < cfg.dwellMs) continue;

    const reason: StrandReason = quotaArm ? 'quota' : 'adapter';
    strandedSet.push({
      sessionKey: rec.sessionKey,
      ownerMachineId: rec.ownerMachineId,
      reason,
      strandedSince,
      ownerBeatAgeMs: beatAgeMs,
      servablePeerExists: servablePeerExists(rec, capacities, selfMachineId, input.resolveScope),
    });
  }

  return { strandedSet, cantAssessCount, nextStrandedSince };
}

/**
 * Whether SOME online machine could serve the topic's channel — narrowly "online
 * AND not quota-blocked AND machineServesChannel(...) === 'yes'" (the same
 * PlacementExecutor filter, so detector + placement agree). Deliberately NOT a
 * "safe failover target": it vets no pin policy, lease/router readiness, secrets,
 * or session limits — v1 never fails over, so this only tells the operator
 * "somewhere could serve this" vs "nowhere can (fleet-wide wall)". When the scope
 * can't be derived, a not-quota-blocked online peer counts (quota-arm semantics).
 */
function servablePeerExists(
  rec: SessionOwnershipRecord,
  capacities: MachineCapacity[],
  selfMachineId: string,
  resolveScope?: (sessionKey: string) => ChannelScope | undefined,
): boolean {
  const scope = resolveScope?.(rec.sessionKey);
  for (const c of capacities) {
    if (c.machineId === rec.ownerMachineId) continue;
    if (!c.online) continue;
    if (c.quotaState?.blocked === true) continue;
    if (scope === undefined) {
      // No channel scope → quota-arm semantics: a healthy peer suffices.
      return true;
    }
    if (machineServesChannel(c.servesChannels, scope) === 'yes') return true;
  }
  return false;
}
