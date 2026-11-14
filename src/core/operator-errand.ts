/**
 * Operator-errand detector (reach-aware B17_FALSE_BLOCKER signal).
 *
 * SIGNAL ONLY. A cheap, brittle phrase pre-filter that flags outbound text which
 * ASKS THE OPERATOR TO LOOK AT, CHECK, OR DO something on the agent's behalf
 * ("I need your eye on it", "can you check the dashboard", "only your browser
 * can see that", "message me in Slack so the conversation appears"). It holds NO
 * blocking authority and judges NOTHING about whether the ask is needed. The
 * full-context MessagingToneGate LLM is the authority: it combines this signal
 * with the AGENT REACH context (the accounts the agent's browser profiles hold
 * and what the agent's own key can read) and fires B17 only when that reach
 * plainly covers the errand. Per Signal-vs-Authority the regex flags, the gate
 * decides, and a miss just sends the ask (harmless).
 *
 * Earned 2026-11-09 (Echo Bugs topic 10000002506): twice in one hour an agent
 * asked the operator to check a dashboard list its own key could read, then to
 * message it in Slack when its browser held the operator's signed-in account.
 *
 * Distinct from `ask-when-authorized.ts` (permission-seeking) and
 * `parked-on-user.ts` (deferring a follow-up action): this flags handing the
 * operator an errand — a look, a check, or a send — the agent might do itself.
 */

/** Phrases that hand the operator a look / check / send errand. Case-insensitive. */
const ERRAND_PHRASES: readonly string[] = [
  'need your eye',
  'need your eyes',
  'your eyes on',
  'your eye on',
  'can you check',
  'could you check',
  'can you look',
  'could you look',
  'can you take a look',
  'could you take a look',
  'take a quick look',
  'have a look at',
  'can you confirm what you see',
  'tell me what you see',
  'what do you see',
  'can you verify',
  'could you verify',
  'only your browser',
  'only you can see',
  'only you can check',
  'only you can do',
  'from your phone',
  'on your phone',
  'on your screen',
  'in your browser',
  'your logged-in',
  'your signed-in',
  'message me in',
  'talk to me in',
  'send me a message in',
  'send me a dm',
  'dm me in',
  'ping me in',
  'if you message me',
  'once you message me',
  'after you message me',
  'once you send',
  'can you send',
  'could you send',
  'can you open',
  'could you open',
  'can you try',
  'could you try',
  'needs you to',
  'need you to',
];

export interface OperatorErrandSignal {
  /** True when an errand-shaped phrase is present (a SIGNAL, not a verdict). */
  errand: boolean;
  /** The first matched phrase, bounded — for the gate's context. */
  phrase?: string;
}

/**
 * Detect an errand-shaped ask of the operator. Returns `{ errand: false }` when
 * none is found. This NEVER decides whether the errand is a false blocker — the
 * gate decides, combining this with the AGENT REACH context.
 */
export function detectOperatorErrand(text: string): OperatorErrandSignal {
  if (typeof text !== 'string' || !text) return { errand: false };
  const lc = text.toLowerCase().replace(/[’‘]/g, "'");
  for (const phrase of ERRAND_PHRASES) {
    if (lc.includes(phrase)) {
      return { errand: true, phrase: phrase.slice(0, 60) };
    }
  }
  return { errand: false };
}
