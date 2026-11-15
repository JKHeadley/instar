/**
 * Who may be shown a session's transcript (native-conversation-any-machine-access §3d item 2).
 *
 * A transcript is a session's working record: every text it was given, its narration and its tool
 * calls. It is read by the owner, and by the agent for its own operation, never by a member or a
 * guest. The owner is shown it only where the owner may see EVERY conversation the session served:
 * the most restrictive result over those conversations. The audience is resolved at read time from
 * this machine's own copy of the signed team record, so a grant or a revocation made after the
 * transcript was written takes effect on the owner's next read here.
 *
 * Currency (owner's read only): with team access on, the read is refused while the team log has a
 * gap or the team puller is refusing, the two facts behind `access-being-checked`. Stated limit
 * (§3d): a machine whose peers show no sign of being awake does not refuse; the puller decides that.
 *
 * Pure: every input is passed in, so the decision is testable on both sides of each boundary.
 */
import type { ConfinedEntry } from './TeamAccessLog.js';

export type TranscriptAudienceRefusal =
  /** A phone, a team member or a guest: never a transcript, whatever they were granted. */
  | 'not-owner'
  /** The answering machine is older and could not say whose conversation the session served. */
  | 'older-peer'
  /** The team log has a gap, or the team puller is refusing: who may see it cannot be confirmed now. */
  | 'access-being-checked'
  /** The confined list or the team record cannot be read while team access is on. */
  | 'unreadable'
  /** One of the conversations is private to another person and the owner holds no grant to it. */
  | 'private-to-someone-else';

export interface TranscriptAudienceInput {
  /** Who is asking through the route. Only the owner (the API token holder) is ever answered. */
  principal: 'owner' | 'device';
  /** The conversations the session served; undefined when the answering machine sent no such field. */
  conversations: readonly string[] | undefined;
  /** Team access is on (an unreadable log counts as on: the strict direction). */
  teamOn: boolean;
  /** Any sign this agent has ever had a team (access files, team phones). */
  teamEver: boolean;
  /** The confined list: a map (empty on a never-team agent), or null when it cannot be read. */
  confined: ReadonlyMap<string, ConfinedEntry> | null;
  /** The owner's person key and the grants from the signed team record, or null when unreadable. */
  record: { ownerPersonKey: string | null; grants: ReadonlyMap<string, ReadonlyMap<string, unknown>> } | null;
  /** `teamLog().gaps().length`. */
  gaps: number;
  /** `teamPuller.refusing()`. */
  pullerRefusing: boolean;
}

export type TranscriptAudienceVerdict = { ok: true } | { ok: false; reason: TranscriptAudienceRefusal };

/** The fixed sentences a refusal reads as (FD-15: changing one is a spec change). */
export const TRANSCRIPT_AUDIENCE_SENTENCES: Record<TranscriptAudienceRefusal, string> = {
  'not-owner': 'Session transcripts are shown to the owner only.',
  'older-peer': 'That machine runs an older version and cannot say whose conversation this session served.',
  'access-being-checked': 'This machine cannot confirm who may see this session right now.',
  unreadable: 'This machine cannot confirm who may see this session right now.',
  'private-to-someone-else': 'This session serves a conversation that is private to someone else.',
};

export function resolveTranscriptAudience(input: TranscriptAudienceInput): TranscriptAudienceVerdict {
  if (input.principal !== 'owner') return { ok: false, reason: 'not-owner' };
  if (input.conversations === undefined) {
    // A team of one loses nothing: an agent that never had a team is served as today.
    return input.teamOn || input.teamEver ? { ok: false, reason: 'older-peer' } : { ok: true };
  }
  if (input.teamOn && (input.gaps > 0 || input.pullerRefusing)) return { ok: false, reason: 'access-being-checked' };
  // A session with no conversation (a job, a hand-started session) is the owner's.
  if (input.conversations.length === 0) return { ok: true };
  if (input.confined === null) return { ok: false, reason: 'unreadable' };
  if (input.teamOn && input.record === null) return { ok: false, reason: 'unreadable' };
  for (const ref of input.conversations) {
    const entry = input.confined.get(ref);
    // Not confined: an ordinary conversation, which the owner sees. A shared confined place
    // (a team place with no single person) is one the owner is part of.
    if (!entry || !entry.personKey) continue;
    if (!input.record) return { ok: false, reason: 'unreadable' };
    const owner = input.record.ownerPersonKey;
    if (owner && entry.personKey === owner) continue;
    if (owner && input.record.grants.get(owner)?.has(ref)) continue;
    return { ok: false, reason: 'private-to-someone-else' };
  }
  return { ok: true };
}
