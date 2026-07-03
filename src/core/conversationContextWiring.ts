/**
 * conversationContextWiring — the WIRING-layer principal computation for the
 * context-aware outbound review feature (spec §D1/§D4, Know Your Principal).
 *
 * The CoherenceGate stays decoupled from src/users/ and src/memory/: it sees
 * only the injected `conversationContextProvider` function. THIS module is
 * what the server wires that provider to — it converts raw TopicMemory rows
 * plus the topic's verified-operator binding into the provider's return shape:
 * role-labeled rows with per-row `verifiedOperator` tags AND the window's
 * structural `askLicenseMode` (R4-m1: the provider RETURNS the wiring-computed
 * values — the gate copies the mode into `conversationContextMeta` and NEVER
 * computes or infers it).
 *
 * Principal rules (§D4, all computed from AUTHENTICATED uids — never content):
 *  - Role comes from the store's `fromUser` column, never message text.
 *  - BOUND topic (TopicOperatorStore binding present): mode =
 *    'verified-operator'; each user row whose authenticated `telegramUserId`
 *    matches the binding uid is tagged `verifiedOperator: true` (rendered
 *    `USER(verified-operator):`); non-matching and uid-less rows render plain
 *    `USER:` (weak corroboration by the prompt contract).
 *  - UNBOUND topic: 'single-sender' ONLY when EVERY user-role row in the
 *    window carries an authenticated uid AND exactly ONE distinct uid appears
 *    (R4-L1: "at most one" would misread a zero-uid window as licensed).
 *    A window containing ANY uid-less user-role row — or 2+ distinct uids, or
 *    zero user rows — computes 'weak-corroboration-only' (R3-M2: an
 *    unverifiable sender can never help LICENSE; fail-closed).
 *
 * A throw anywhere in here is a PROVIDER throw, caught at acquisition inside
 * CoherenceGate._evaluate per §D5 (degrades to no context section).
 */

import type {
  AskLicenseMode,
  ConversationContextMessage,
} from './untrustedConversationContext.js';

/** The subset of a TopicMemory row this computation reads. */
export interface ConversationSourceRow {
  text: string;
  fromUser: boolean;
  /** Telegram numeric user ID — the authoritative authenticated identity. */
  telegramUserId?: number | null;
}

/** The provider return shape (CoherenceGateOptions.conversationContextProvider). */
export interface ConversationContextProviderResult {
  messages: ConversationContextMessage[];
  askLicenseMode: AskLicenseMode;
}

/**
 * Compute the provider result from raw rows + the topic's verified-operator
 * binding (null when the topic is unbound). Pure and synchronous.
 */
export function buildConversationContext(
  rows: ConversationSourceRow[],
  operator: { uid: string } | null,
): ConversationContextProviderResult {
  const boundUid = operator && typeof operator.uid === 'string' && operator.uid.length > 0
    ? operator.uid
    : null;

  const messages: ConversationContextMessage[] = rows.map((r) => {
    const role: 'user' | 'agent' = r.fromUser ? 'user' : 'agent';
    const msg: ConversationContextMessage = {
      role,
      text: typeof r.text === 'string' ? r.text : String(r.text ?? ''),
    };
    if (
      boundUid !== null &&
      role === 'user' &&
      r.telegramUserId !== null &&
      r.telegramUserId !== undefined &&
      String(r.telegramUserId) === boundUid
    ) {
      msg.verifiedOperator = true;
    }
    return msg;
  });

  let askLicenseMode: AskLicenseMode;
  if (boundUid !== null) {
    // Bound topic: the binding IS the license authority. Uid-less rows are
    // already rendered plain USER: (weak corroboration) by the tag rule above.
    askLicenseMode = 'verified-operator';
  } else {
    const userRows = rows.filter((r) => r.fromUser);
    const uids = new Set<string>();
    let anyUidless = userRows.length === 0; // zero user rows can never license
    for (const r of userRows) {
      if (r.telegramUserId === null || r.telegramUserId === undefined) {
        anyUidless = true;
      } else {
        uids.add(String(r.telegramUserId));
      }
    }
    askLicenseMode = !anyUidless && uids.size === 1
      ? 'single-sender'
      : 'weak-corroboration-only';
  }

  return { messages, askLicenseMode };
}
