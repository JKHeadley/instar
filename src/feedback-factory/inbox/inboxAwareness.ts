/**
 * Agent-awareness text for the feedback inbox's token sources (spec
 * docs/specs/feedback-inbox-vault-token.md §D). Shared by the CLAUDE.md
 * template and the PostUpdateMigrator refresh so new and existing agents read
 * the same sentence.
 */

/** The sentence every agent installed before the vault fallback carries. */
export const FEEDBACK_INBOX_TOKEN_SENTENCE_OLD =
  'Ships dark behind `feedbackFactory.receiverPersistence.enabled` + a Blob token env; the route 503s when dark.';

export const FEEDBACK_INBOX_TOKEN_SENTENCE =
  'Ships dark behind `feedbackFactory.receiverPersistence.enabled`. It runs only on the operated host ' +
  '(`feedbackFactory.operatedHostMachineId`) and reads its Blob token from env `FEEDBACK_INBOX_BLOB_TOKEN`, ' +
  'else vault key `feedback_inbox_blob_token` (the server runs inside tmux, so lifeline env does not reach it: ' +
  'keep the token in the vault). The route 503s when dark; a missing token on the operated host shows as a ' +
  '`FeedbackInbox.blobToken` degradation.';

/** Replace the old sentence in place; a no-op when it has drifted or is already current. */
export function refreshFeedbackInboxTokenAwareness(content: string): string {
  return content.split(FEEDBACK_INBOX_TOKEN_SENTENCE_OLD).join(FEEDBACK_INBOX_TOKEN_SENTENCE);
}
