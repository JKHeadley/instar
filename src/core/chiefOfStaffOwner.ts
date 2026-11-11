/**
 * Chief of Staff owner rules (docs/specs/chief-of-staff-topic.md §6) — one place, used by every seam.
 *
 * The Chief of Staff conversation accepts input only from the agent's owner. Echo Bugs topic
 * 10000002533 (2026-11-10): an agent turned the feature on with no owner configured, the
 * owner-only gate then refused the operator's own messages six times, and the standby proxy still
 * told the operator each one "has been delivered to the session". Three rules close that:
 *
 *  1. The owner is the VERIFIED owner: a configured owner id, else the one verified operator this
 *     machine has ever seen (`resolveApprovalOwner` with the operator bindings — the same answer
 *     approval buttons already use). An existing install that never set an owner binds to its
 *     established operator; with none, there is no owner.
 *  2. With no verified owner the feature stays OFF even when `chiefOfStaff.enabled` is true, and
 *     says so once (no topic is created, the loop and action protocol do nothing).
 *  3. A message this gate refuses is refused everywhere: nothing may later acknowledge it as
 *     delivered (the standby proxy asks `chiefOfStaffInboundVerdict` before it starts a watch).
 */

export type ChiefOfStaffInboundVerdict =
  /** Not the Chief of Staff conversation — this rule has nothing to say. */
  | 'not-cos-topic'
  /** The verified owner: accepted. */
  | 'owner'
  /** No verified owner exists, so nobody can be accepted. */
  | 'no-owner'
  /** A known sender who is not the owner. */
  | 'not-owner'
  /** A sender whose identity could not be verified. */
  | 'unverified';

export interface ChiefOfStaffInboundFacts {
  topicId: number;
  /** The Chief of Staff conversation, or null when there is none (or the gate is not wired). */
  cosTopicId: number | null;
  /** The verified sender id; 0 or undefined when the sender is unverified. */
  senderId: number | undefined;
  /** The verified owner (rule 1), or undefined when there is none. */
  owner: number | undefined;
}

export function chiefOfStaffInboundVerdict(f: ChiefOfStaffInboundFacts): ChiefOfStaffInboundVerdict {
  if (f.cosTopicId === null || f.topicId !== f.cosTopicId) return 'not-cos-topic';
  if (f.owner === undefined) return 'no-owner';
  if (!f.senderId) return 'unverified';
  return f.senderId === f.owner ? 'owner' : 'not-owner';
}

/** True when the inbound must be refused (and therefore never acknowledged as delivered). */
export function chiefOfStaffRefusesInbound(f: ChiefOfStaffInboundFacts): boolean {
  const v = chiefOfStaffInboundVerdict(f);
  return v !== 'not-cos-topic' && v !== 'owner';
}

/** The one plain line the sender gets for a refused message. */
export function chiefOfStaffRefusalLine(v: ChiefOfStaffInboundVerdict): string | null {
  switch (v) {
    case 'no-owner': return 'This message was not delivered. The Chief of Staff is off because this agent has no verified owner yet. Message the agent in any other conversation so it can verify you, or set ownerUserId in its Telegram settings; then messages here will reach it.';
    case 'not-owner': return 'This message was not delivered. Only the owner can talk to the Chief of Staff here.';
    case 'unverified': return 'This message was not delivered. I could not verify who sent it.';
    default: return null;
  }
}

/** Rule 2: the feature is live only when switched on AND a verified owner exists. */
export function chiefOfStaffActive(switchedOn: boolean, owner: number | undefined): boolean {
  return switchedOn && owner !== undefined;
}

export const CHIEF_OF_STAFF_NO_OWNER_NOTICE = {
  feature: 'ChiefOfStaff.owner',
  primary: 'The Chief of Staff works for one verified owner and accepts messages only from them',
  fallback: 'The Chief of Staff stays off: no topic is created and nothing runs',
  reason: 'chiefOfStaff.enabled is on, but no owner is configured and no single verified operator exists',
  impact: 'The Chief of Staff will not start until the owner is set (ownerUserId in the Telegram settings) or the operator messages this agent',
} as const;

/**
 * Wraps the live switch so the "on but no owner" state is reported once per episode (again only
 * after an owner appeared and went away), never once per tick.
 */
export function makeChiefOfStaffGate(deps: {
  switchedOn: () => boolean;
  owner: () => number | undefined;
  /**
   * False while an owner source is still being wired (the "one verified operator" lookup is
   * connected with the routes, after boot starts). The gate still reads OFF then, but does not
   * report "no owner" for what is only a boot-order gap. Omitted ⇒ always ready.
   */
  ownerSourcesReady?: () => boolean;
  reportNoOwner: () => void;
}): () => boolean {
  let reported = false;
  return () => {
    let on = false;
    try { on = deps.switchedOn(); } catch { /* @silent-fallback-ok: an unreadable switch reads as OFF */ on = false; }
    if (!on) return false;
    let owner: number | undefined;
    try { owner = deps.owner(); } catch { /* @silent-fallback-ok: an unreadable owner is no owner — the feature stays off */ owner = undefined; }
    if (chiefOfStaffActive(on, owner)) { reported = false; return true; }
    let ready = true;
    try { ready = deps.ownerSourcesReady ? deps.ownerSourcesReady() : true; } catch { /* @silent-fallback-ok: unknown readiness reports, the safe (loud) side */ ready = true; }
    if (!reported && ready) {
      reported = true;
      try { deps.reportNoOwner(); } catch { /* @silent-fallback-ok: the report is a notice; the feature is already held off */ }
    }
    return false;
  };
}
