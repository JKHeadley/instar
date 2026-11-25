/**
 * The owner-chat surface the phone approval flows use, and what an Approve or Decline tap shows
 * afterwards (docs/specs/throwaway-owner-chat.md §1).
 *
 * `TelegramAdapter` implements `OwnerChatSurface` for a real owner chat; the throwaway stand-in
 * (`src/server/throwawayOwnerChat.ts`) implements it for a test agent with no owner. Both read the
 * tap's visible results from the functions below, so the words a person sees cannot drift
 * between the two.
 */

export interface OwnerChatButton { text: string; data: string }

/** What an Approve handler answers (the same shape `TelegramAdapter.mobileApproveHandler` returns). */
export interface OwnerApproveResult { outcome: 'approved' | 'ended' | 'other'; text: string; client?: 'phone' | 'browser' }
/** `text`: a handler that is not about pairing gives its own words (identity-security piece 3a §6). */
export type OwnerDeclineRaw = 'declined' | 'unknown' | 'already-approved' | { result: 'declined' | 'unknown' | 'already-approved'; client?: 'phone' | 'browser'; text?: string };

export type OwnerApproveHandler = (nonce: string) => OwnerApproveResult;
export type OwnerDeclineHandler = (nonce: string) => OwnerDeclineRaw;

/**
 * The owner's private chat, as the approval flows need it. `sendOwnerDMWithButton` answers a positive
 * message id, null (not delivered), or (Telegram with `reportHeld`) -1: held, may still land.
 */
export interface OwnerChatSurface {
  sendOwnerDMWithButton(text: string, button: OwnerChatButton | OwnerChatButton[] | null, opts?: { reportHeld?: boolean }): Promise<number | null>;
  mobileApproveHandler: OwnerApproveHandler | null;
  mobileDeclineHandler: OwnerDeclineHandler | null;
}

/** Approve and Decline button data: the pairing nonce, 24 hex characters. */
export const OWNER_APPROVE_DATA_RE = /^md:a:([0-9a-f]{24})$/;
export const OWNER_DECLINE_DATA_RE = /^md:d:([0-9a-f]{24})$/;

/** The visible result of an Approve tap: its toast, whether the buttons go, and the message sent after. */
export function approveTapResult(r: OwnerApproveResult): { toast: string; removeButtons: boolean; confirmation: string | null; approved: boolean } {
  const browser = r.client === 'browser';
  if (r.outcome !== 'approved') return { toast: r.text, removeButtons: false, confirmation: null, approved: false };
  return {
    toast: browser ? 'Approved. That browser is set up.' : 'Approved. That phone is paired.',
    // The code stays in the message: a shipped app's code box only submits a complete-looking code,
    // and once the phone is active any such code finishes it. Only the buttons go.
    removeButtons: true,
    confirmation: browser
      ? 'Approved. That browser can now use your conversations with this agent. If the dashboard still shows a code box, type the code above to finish. You can remove the browser any time on the Phones page.'
      : 'Approved. That phone is paired with this agent. If the app still shows a code box, type the code above to finish. You can remove the phone any time on the Phones page.',
    approved: true,
  };
}

/** The visible result of a Decline tap: its toast and, when declined, the text that replaces the message. */
export function declineTapResult(raw: OwnerDeclineRaw): { toast: string; replaceText: string | null; declined: boolean } {
  const r = typeof raw === 'string' ? raw : raw.result;
  const browser = typeof raw !== 'string' && raw.client === 'browser';
  // dashboard-conversations-browser-device §4.1: a Decline that loses to an approval already under
  // way is answered "already approved", never as declined.
  const own = typeof raw !== 'string' && typeof raw.text === 'string' ? raw.text : null;
  const toast = own ?? (r === 'declined' ? (browser ? 'Declined. That browser will not be set up.' : 'Declined. That phone will not be paired.')
    : r === 'already-approved' ? "Already approved — remove it on the Phones page if this wasn't you."
    : 'This pairing has already ended.');
  return { toast, replaceText: r === 'declined' ? (own ?? (browser ? 'Declined. That browser was not set up.' : 'Declined. That phone was not paired.')) : null, declined: r === 'declined' };
}
