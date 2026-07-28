/**
 * Ask-when-authorized detector (Standing-Authorization signal for B17_FALSE_BLOCKER).
 *
 * SIGNAL ONLY. A cheap, brittle phrase pre-filter that flags outbound text which
 * SEEKS the operator's permission / approval / a go-ahead so the agent can proceed
 * ("ready for your go-ahead?", "shall I…", "want me to…", "approve and I'll…").
 * It holds NO blocking authority and judges NOTHING about whether the ask is
 * legitimate — the full-context MessagingToneGate LLM is the authority that
 * decides whether B17_FALSE_BLOCKER fires, combining THIS signal with the
 * verified `standingAuthorization` context (asking for permission is a false
 * blocker ONLY when that permission was already granted, and the action is not a
 * FLOOR action). Per Signal-vs-Authority, the regex flags; the gate decides; the
 * fail direction is toward SENDING (a miss just sends an ask — harmless).
 *
 * Distinct from `parked-on-user.ts` (B19): B-PARK flags DEFERRING a finished
 * action onto the user; this flags SEEKING permission to start one.
 *
 * Spec: docs/specs/BIAS-TO-ACTION-SPEC.md (D2).
 */

/** Phrases that seek operator permission/approval to proceed. Case-insensitive. */
const ASK_PHRASES: readonly string[] = [
  'ready for your go-ahead',
  'ready for your go ahead',
  'your go-ahead',
  'give me the go-ahead',
  'give me the green light',
  'waiting on your approval',
  'waiting for your approval',
  'waiting on your go-ahead',
  'pending your approval',
  'awaiting your approval',
  'need your approval',
  'need your sign-off',
  'need your sign off',
  'for your go-ahead',
  'shall i',
  'should i proceed',
  'should i go ahead',
  'want me to',
  'do you want me to',
  'would you like me to',
  'should i build',
  'should i ship',
  'should i merge',
  'should i deploy',
  'approve and i',
  'approve and then i',
  'just say the word',
  'let me know if i should',
  'let me know if you want me to',
  'let me know whether to',
  'if you approve',
  'with your ok',
  'with your okay',
  'with your sign-off',
];

export interface AskWhenAuthorizedSignal {
  /** True when a permission-seeking phrase is present (a SIGNAL, not a verdict). */
  asking: boolean;
  /** The first matched phrase, bounded — for the gate's context. */
  phrase?: string;
}

/**
 * Detect a permission-seeking phrase. Returns `{ asking: false }` when none is
 * found. This NEVER decides whether the ask is a false blocker — that is the
 * gate's job, combining this with the `standingAuthorization` context.
 */
export function detectAskWhenAuthorized(text: string): AskWhenAuthorizedSignal {
  if (typeof text !== 'string' || !text) return { asking: false };
  const lc = text.toLowerCase();
  for (const phrase of ASK_PHRASES) {
    if (lc.includes(phrase)) {
      return { asking: true, phrase: phrase.slice(0, 60) };
    }
  }
  return { asking: false };
}
