/**
 * The inviter's record of its open pairing invites (docs/specs/a2a-pairing-invite-link.md §4.1, §4.4),
 * and the recipient's record of the invites its operator approved.
 *
 * The implementation lives in `@sagemindai/threadline-core` (spec
 * docs/specs/threadline-standalone-pairing.md D1, rollout step 3); this module re-exports it under
 * its old path. One JSON file, mode 0600, under `<stateDir>/threadline/`. The one-time secret S is
 * kept only while an invite is open. A file that is not valid JSON is moved aside and reported
 * (never overwritten); an unreadable one makes the constructor throw.
 */

export { PairingInviteStore, INVITE_STORE_FILE, INVITE_EVENTS_FILE } from '@sagemindai/threadline-core';
export type {
  InviteState, InviteAcceptor, StoredInvite, ApprovedAccept, InviteSummary, InviteEventName,
} from '@sagemindai/threadline-core';
