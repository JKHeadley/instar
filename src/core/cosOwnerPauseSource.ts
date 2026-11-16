/**
 * The source floor for a Chief of Staff pause / resume ask (docs/specs/cos-owner-pause-record.md §3.2).
 *
 * The agent may ASK the owner to pause or resume a tracked project only when it cites the owner's own
 * logged words asking for it. This module checks that citation against the logged record, in code:
 * one Telegram marker, the row found, a person (not the agent) wrote it, the row is the owner's own
 * inbound message (not a forward, not a team member who shares a name), and the quoted words are in it.
 *
 * Signal vs. Authority: this is an exact-fact check that only gates whether the owner is ASKED. The
 * authority over the pause itself is the owner's Telegram tap, verified by the adapter. The same check
 * runs again at tap time against the marker carried in the ask message, so nothing is taken from memory.
 */
import type { MessageAuthorship } from './AspAuthorshipJoin.js';
import { parseMarkers, type SourceRef } from './attribution/marker.js';
import { checkEligibility, type IdentityMap } from './attribution/recordEligibility.js';
import type { ResolveResult } from './attribution/SourceResolver.js';
import { OWNER_PAUSE_QUOTE_MAX } from './ChiefOfStaffStore.js';

export interface OwnerPauseSourceDeps {
  resolve: (ref: SourceRef) => Promise<ResolveResult>;
  /** The verified owner's Telegram uid (the same principal the `cos:` button check uses). */
  ownerUid: () => number | string | undefined | null;
  identity: IdentityMap;
}

export type OwnerPauseSourceRefusal =
  | 'marker-malformed' | 'channel-not-supported' | 'message-unreadable'
  | 'not-found' | 'pinned-copy' | 'unverifiable' | 'unreachable' | 'removed'
  | 'not-human' | 'owner-unknown' | 'not-owner'
  | 'not-inbound' | 'unproven-provenance' | 'forwarded' | 'agent-authored' | 'identity-unverified' | 'not-this-person';

export type OwnerPauseSource =
  | { ok: true; ref: SourceRef; marker: string; at: string; ownerText: string }
  | { ok: false; reason: OwnerPauseSourceRefusal };

/** No agent-chosen quote: the ask shows and records the owner's WHOLE message, so a fragment can never be cut out of it. */
export async function checkOwnerPauseSource(deps: OwnerPauseSourceDeps, marker: unknown): Promise<OwnerPauseSource> {
  if (typeof marker !== 'string') return { ok: false, reason: 'marker-malformed' };
  const parsed = parseMarkers(marker);
  if (parsed.markers.length !== 1 || parsed.malformed.length > 0) return { ok: false, reason: 'marker-malformed' };
  const { ref, raw } = parsed.markers[0];
  if (ref.channel !== 'telegram') return { ok: false, reason: 'channel-not-supported' };
  const resolved = await deps.resolve(ref);
  if (resolved.outcome !== 'found' || !resolved.row) return { ok: false, reason: resolved.outcome === 'found' ? 'not-found' : resolved.outcome };
  const authorship: MessageAuthorship | undefined = resolved.authorship;
  if (authorship !== 'human') return { ok: false, reason: 'not-human' };
  const row = resolved.row;
  const owner = deps.ownerUid();
  if (owner === undefined || owner === null || String(owner) === '') return { ok: false, reason: 'owner-unknown' };
  // The real owner gate: the row's sender id IS the owner's id. Name matching alone would pass a team
  // member who shares the owner's first name, so this compares ids (as strings: rows hold numbers).
  if (row.telegramUserId === undefined || String(row.telegramUserId) !== String(owner)) return { ok: false, reason: 'not-owner' };
  const person = deps.identity('telegram', String(row.telegramUserId), { conversation: ref.conversation });
  if (!person) return { ok: false, reason: 'identity-unverified' };
  const eligibility = checkEligibility({ channel: 'telegram', conversation: ref.conversation, row, person, identity: deps.identity, authorship });
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };
  // Telegram caps a message at 4096 characters, so a real owner message always fits the record whole.
  if (typeof row.text !== 'string' || !row.text.trim() || row.text.length > OWNER_PAUSE_QUOTE_MAX) return { ok: false, reason: 'message-unreadable' };
  const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return { ok: true, ref, marker: raw, at: Number.isFinite(ts) ? new Date(ts).toISOString() : `${ref.date}T00:00:00.000Z`, ownerText: row.text };
}

/** Telegram's message length limit (characters). */
export const TELEGRAM_MESSAGE_MAX = 4096;

/**
 * The ask the owner taps under (spec §3.2). The owner's WHOLE message is always shown: when it would not fit in one
 * message with the ask, `separateOwnerMessage` is true and the caller sends the owner's message first, whole.
 */
export function composePauseAsk(input: { action: 'pause' | 'resume'; title: string; ownerText: string; marker: string; writtenIn: string | null; date: string; olderMachines: string[] }): { text: string; separateOwnerMessage: boolean } {
  const where = input.writtenIn ? ` in ${input.writtenIn}` : '';
  const tail = input.action === 'pause'
    ? "Pause it? Until you resume it I won't check it, restart it or nudge it. A session already running keeps going until it ends, and runs you started yourself are not affected."
    : "Resume it? I'll start checking it again on its usual cadence.";
  const older = input.olderMachines.length ? ` Not enforced on ${input.olderMachines.join(', ')} until it updates.` : '';
  const whole = `${input.title}: you wrote${where} on ${input.date}: “${input.ownerText}” ${input.marker}. ${tail}${older}`;
  if (whole.length <= TELEGRAM_MESSAGE_MAX) return { text: whole, separateOwnerMessage: false };
  return { text: `${input.title}: you wrote${where} on ${input.date} (above) ${input.marker}. ${tail}${older}`, separateOwnerMessage: true };
}
