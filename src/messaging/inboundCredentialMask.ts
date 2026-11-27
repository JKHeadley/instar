/**
 * inboundCredentialMask — SEC-164 part 1 §3.5 and §4.5: every new incoming message has its live keys
 * masked before the first side effect that keeps the text, and a team member whose key was removed
 * gets one fixed notice with a one-tap Secret Drop link.
 *
 * Part 1 never keeps a key from a message (Chief of Staff, option A). Strangers get no notice.
 */
import {
  findWallCredentialSpans, CREDENTIAL_REMOVED_MARKER, type OwnCredentialMatcher,
} from './outbound-credential-guard.js';

export interface InboundMaskResult {
  /** The text to store and deliver: masked when a key was found, otherwise the input unchanged. */
  text: string;
  /** The kinds removed, never the values. Empty when nothing was removed. */
  kinds: string[];
  /** 'masked' | 'clean' | 'off' (switch off) | 'fallback' (own-credential step failed; patterns only) | 'failed' (delivered unchanged). */
  outcome: 'masked' | 'clean' | 'off' | 'fallback' | 'failed';
}

export interface InboundMaskOptions {
  enabled: boolean;
  ownCredentials?: OwnCredentialMatcher | null;
  /** Called once per failure so it can be reported through the degradation report. Never given text. */
  onFailure?: (reason: string) => void;
}

function applySpans(text: string, spans: Array<{ kind: string; start: number; end: number }>): InboundMaskResult {
  if (spans.length === 0) return { text, kinds: [], outcome: 'clean' };
  let out = '';
  let last = 0;
  for (const s of spans) { out += text.slice(last, s.start) + CREDENTIAL_REMOVED_MARKER; last = s.end; }
  out += text.slice(last);
  return { text: out, kinds: [...new Set(spans.map((s) => s.kind))], outcome: 'masked' };
}

/**
 * Mask the live keys in one incoming message. Never throws. If the full check fails it falls back to
 * the wall's patterns alone; if that fails too the message is delivered unchanged, because the
 * operator's channel fails toward delivery.
 */
export function maskInbound(text: string, options: InboundMaskOptions): InboundMaskResult {
  if (typeof text !== 'string' || text.length === 0) return { text, kinds: [], outcome: 'clean' };
  if (!options.enabled) return { text, kinds: [], outcome: 'off' };
  try {
    return applySpans(text, findWallCredentialSpans(text, { ownCredentials: options.ownCredentials ?? null }));
  } catch (err) {
    options.onFailure?.(`full check failed: ${err instanceof Error ? err.name : 'error'}`);
  }
  try {
    const r = applySpans(text, findWallCredentialSpans(text));
    return { ...r, outcome: r.outcome === 'masked' ? 'fallback' : r.outcome };
  } catch (err) {
    options.onFailure?.(`patterns-only check failed: ${err instanceof Error ? err.name : 'error'}`);
    // @silent-fallback-ok — reported above; the operator channel fails toward delivery, and the sweeper and part 2 mask later copies.
    return { text, kinds: [], outcome: 'failed' };
  }
}

export interface TeamSenderInput {
  channel: 'telegram' | 'slack' | 'app' | 'whatsapp' | 'imessage';
  senderId: string | number | null | undefined;
  /** The owner's id on this channel, from the config. */
  ownerIds?: ReadonlyArray<string | number | null | undefined>;
  /** Ids of team members on this channel, from users.json (read by the caller). */
  memberIds?: ReadonlyArray<string | number | null | undefined>;
  /** Telegram: true when the message was forwarded, posted as a chat, sent by an anonymous admin, or via a bot. */
  notFromThePerson?: boolean;
  /** Slack: true for a guest or an external (Slack Connect) user. */
  externalOrGuest?: boolean;
}

/**
 * Whether the notice is sent. Decides nothing else: a wrong answer costs at most one notice, because
 * nothing is saved. Unknown or unreadable team data means only the owner counts.
 */
export function isTeamSender(input: TeamSenderInput): boolean {
  if (input.senderId === null || input.senderId === undefined || String(input.senderId) === '') return false;
  if (input.notFromThePerson || input.externalOrGuest) return false;
  const id = String(input.senderId);
  const match = (list?: ReadonlyArray<string | number | null | undefined>) =>
    !!list && list.some((v) => v !== null && v !== undefined && String(v) === id);
  return match(input.ownerIds) || match(input.memberIds);
}

/** The fixed team-member notice (§4.5). Written by the server, never by a session. */
export function teamMemberNotice(secretDropLink: string | null): string {
  if (!secretDropLink) {
    return 'I removed a key from your message, to keep it out of the conversation. Nothing else happened to it: it was not saved or used. '
      + 'I could not make a safe link to send it right now. Please try again in a minute.';
  }
  return 'I removed a key from your message, to keep it out of the conversation. Nothing else happened to it: it was not saved or used. '
    + `If you meant me to have it, send it here instead: ${secretDropLink}`;
}

/** The one-line note the receiving session sees, so it does not ask for the key in the conversation. */
export function sessionRemovedKeyNote(teamNoticeSent: boolean): string {
  return teamNoticeSent
    ? '[A key was removed from this message for safety. The person was sent a Secret Drop link to send it safely; do not ask them to paste it here.]'
    : '[A key was removed from this message for safety.]';
}
