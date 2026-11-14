/**
 * peerPlaceAdmission — whether another agent's message may run in a place of its own.
 * Spec: docs/specs/memory-privacy-agent-places.md §1.
 *
 * Pure and deterministic. This is a boundary, so every missing input fails closed.
 * One decision is used before every delivery of peer text into a place (spawn, launch,
 * live inject, a second thread into a live place session, the drain) and by the
 * `agentSessions` status, so the app never advertises what admission would refuse.
 */

/** The place-key prefix of another agent's place. */
export const PEER_PLACE_PREFIX = 'agent:';

/** The tmux-name marker of a session in another agent's place. */
export const PEER_PLACE_SESSION_MARKER = 'msg-place-';

/** Trust sources an owner or a pairing sets. `setup-default` is what a stranger gets. */
const GRANTED_SOURCES = new Set(['user-granted', 'paired-machine-granted', 'mutual-verified']);
const ADMITTED_LEVELS = new Set(['verified', 'trusted', 'autonomous']);

export const AGENT_SESSIONS_REFUSED_REASON = 'agent-to-agent sessions are off on an agent that serves several people';

export interface PeerAdmissionInput {
  /** Memory privacy on and more than one person can reach the agent. */
  multiPerson: boolean;
  /** The sender's authenticated fingerprint, or null when there is none. */
  fingerprint: string | null;
  /** The peer's trust profile, or null when it has none. */
  trust: { source: string | null; level: string | null } | null;
  /** `memoryPrivacy.refuseAgentSessions`, read live. */
  refuseAgentSessions: boolean;
  /** A scoped session can start here: claude-code and a working sandbox. */
  scopedSessionsReady: boolean;
}

export type PeerAdmission =
  /** Not a multi-person agent: today's behaviour, unchanged. */
  | { kind: 'today' }
  /** Run in this peer's place. */
  | { kind: 'place'; placeKey: string; fingerprint: string }
  /** Refused, with the reason the spawn manager reports. */
  | { kind: 'refused'; reason: string; cause: 'no-identity' | 'no-grant' | 'switch' | 'no-sandbox' };

export function hasExplicitGrant(trust: PeerAdmissionInput['trust']): boolean {
  return !!trust && GRANTED_SOURCES.has(trust.source ?? '') && ADMITTED_LEVELS.has(trust.level ?? '');
}

export function decidePeerAdmission(input: PeerAdmissionInput): PeerAdmission {
  if (!input.multiPerson) return { kind: 'today' };
  const fp = typeof input.fingerprint === 'string' ? input.fingerprint.trim() : '';
  if (!fp) return { kind: 'refused', reason: AGENT_SESSIONS_REFUSED_REASON, cause: 'no-identity' };
  if (!hasExplicitGrant(input.trust)) return { kind: 'refused', reason: AGENT_SESSIONS_REFUSED_REASON, cause: 'no-grant' };
  if (input.refuseAgentSessions) return { kind: 'refused', reason: AGENT_SESSIONS_REFUSED_REASON, cause: 'switch' };
  if (!input.scopedSessionsReady) return { kind: 'refused', reason: AGENT_SESSIONS_REFUSED_REASON, cause: 'no-sandbox' };
  return { kind: 'place', placeKey: `${PEER_PLACE_PREFIX}${fp}`, fingerprint: fp };
}

/** What `GET /memory-privacy` reports as `agentSessions`. */
export type AgentSessionsStatus = 'own-place' | 'refused' | 'owner-reach';

export function agentSessionsStatus(input: { multiPerson: boolean; refuseAgentSessions: boolean; scopedSessionsReady: boolean }): AgentSessionsStatus {
  if (!input.multiPerson) return 'owner-reach';
  if (input.refuseAgentSessions || !input.scopedSessionsReady) return 'refused';
  return 'own-place';
}

/** True for a place key that belongs to another agent. */
export function isPeerPlaceKey(placeKey: string | null | undefined): placeKey is string {
  return typeof placeKey === 'string' && placeKey.startsWith(PEER_PLACE_PREFIX) && placeKey.length > PEER_PLACE_PREFIX.length;
}

/** The fingerprint in a peer place key, or null. */
export function peerFingerprintOfPlace(placeKey: string | null | undefined): string | null {
  return isPeerPlaceKey(placeKey) ? placeKey.slice(PEER_PLACE_PREFIX.length) : null;
}
