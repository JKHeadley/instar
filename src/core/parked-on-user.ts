/**
 * Parked-on-user detector (C1+C2 "The Agent Carries the Loop" §4.3, B-PARK).
 *
 * SIGNAL ONLY. This is a cheap, brittle regex pre-filter that flags outbound
 * conversational text which DEFERS a future action onto the user — the
 * anti-pattern of the agent quietly handing its own follow-through back to the
 * human ("I'll leave that to you", "let me know when you want me to…"). It holds
 * NO blocking authority: the full-context MessagingToneGate LLM is the authority
 * that decides whether the deferral is illegitimate (an action the agent could
 * own) vs. legitimate (a genuine value/taste/spend decision that is the user's —
 * the human-only set, where the agent SHOULD defer). Per Signal-vs-Authority,
 * the regex flags; the gate decides; the fail direction is toward sending.
 */

/** Phrases that defer an action onto the user. Case-insensitive, whole-ish. */
const PARK_PHRASES: readonly string[] = [
  'your call',
  "whenever you're ready",
  'whenever you’re ready',
  'when you get a chance',
  'let me know when you want',
  'let me know when you',
  'feel free to ping me when',
  'ping me when you',
  "you'll need to",
  'you’ll need to',
  'you will need to',
  'remember to',
  "don't forget to",
  'don’t forget to',
  'up to you',
  'whenever you get to it',
  'when you have a moment',
];

export interface ParkedOnUserSignal {
  /** True when a parked-on-user phrase is present (a SIGNAL, not a verdict). */
  parked: boolean;
  /** The first offending phrase, bounded — for the gate's context. */
  phrase?: string;
}

/**
 * Detect a parked-on-user phrase. Returns `{ parked: false }` when none is found.
 * This never decides whether the deferral is legitimate — that is the gate's job.
 */
export function detectParkedOnUser(text: string): ParkedOnUserSignal {
  if (typeof text !== 'string' || !text) return { parked: false };
  const lc = text.toLowerCase();
  for (const phrase of PARK_PHRASES) {
    if (lc.includes(phrase)) {
      return { parked: true, phrase: phrase.slice(0, 60) };
    }
  }
  return { parked: false };
}
