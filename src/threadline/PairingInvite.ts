/**
 * Pairing invites — the pure core of verified pairing by invite link
 * (docs/specs/a2a-pairing-invite-link.md §4.1–§4.2, §7).
 *
 * The implementation lives in `@sagemindai/threadline-core` (spec
 * docs/specs/threadline-standalone-pairing.md D1, rollout step 3), so Instar and threadline-mcp
 * speak the same invite format, transcript, MAC, tag and check code and cannot drift. This module
 * re-exports it under its old path so Instar's importers are unchanged.
 *
 * Consumers: PairingInviteFlow (the protocol, §4.3–§4.4), PairingInviteStore (the inviter's
 * record), and the places that must recognise an invite without decoding it to keep its secret
 * out of logs and sessions: PairingInviteTelegram, TelegramAdapter, MessageQueue and the
 * dashboard (all via INVITE_PREFIX / findInviteToken).
 */

export {
  INVITE_PREFIX, INVITE_VERSION, INVITE_DEFAULT_TTL_MS, INVITE_MAX_TTL_MS, INVITE_HOW_TO,
  cleanLabel, createInvite, encodeInvite, findInviteToken, classifyInviteText, decodeInvite, isExpired,
  transcript, macKey, inviteTag, verifyInviteTag, checkCode, inviteMessage,
} from '@sagemindai/threadline-core';
export type { InviteDirection, PairingInvite, DecodeResult, TranscriptFields } from '@sagemindai/threadline-core';
