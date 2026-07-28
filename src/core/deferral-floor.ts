/**
 * Deterministic premature-deferral floor — a no-LLM recognizer for the
 * "defer-an-operational-action-to-the-user" shape in an AGENT-OUTBOUND message.
 *
 * Why this exists (the 2026-07-22 correction): the agent asked the operator to
 * perform an operational action it could have done itself ("you start Codey, or
 * set me up with access") INSTEAD of exhausting its own routes first — a single
 * multi-machine agent with a live node on the very machine that needed action.
 * That violates the "Self-Unblock Before Escalating" standard. The operator's
 * directive: "a sentinel that detects when you are deferring to the user and
 * reminds you to re-check your available routes ... before deferring."
 *
 * This is the deterministic recognizer for that sentinel — a sibling of
 * self-stop-floor.ts. It flags the SHAPE (a user-directed request conjoined with
 * an operational-unblock action), NOT the intent: a deferral AFTER genuine route
 * exhaustion is legitimate (self-unblock Rung 2). So the sentinel that consumes
 * this signal REMINDS ("did you re-scan your routes first?"), it does not assert
 * the deferral is wrong — exactly the operator's framing.
 *
 * Threat model: initiative-drift correction, NOT a security boundary. It ships
 * SIGNAL-ONLY and OBSERVE-ONLY first (record the detection, measure the
 * false-positive rate against real outbound traffic) before any reminder is
 * wired — the observe phase is itself the benchmark datum the "every user
 * pushback -> improvement data" pipeline consumes.
 *
 * Precision design (two-axis conjunction, mirrors self-stop-floor):
 *   (A) a USER-DIRECTED REQUEST marker (the agent asking the operator to act), AND
 *   (B) an OPERATIONAL-UNBLOCK ACTION marker (start/restart/run/install/grant/
 *       enable/… — a thing an agent could plausibly do itself), AND
 *   (C) NO legitimate-deferral override (a genuine DECISION only the operator can
 *       make, or an operator-only CREDENTIAL the agent cannot produce).
 * Requiring BOTH axes plus the override guard keeps it high-precision: a genuine
 * design question ("which promotion model do you want?") carries no operational
 * action; a real credential ask ("I need your password") is de-fanged by (C).
 */

export interface DeferralFloorResult {
  /** True when the text expresses the premature-deferral shape. */
  detected: boolean;
  /** The user-directed request phrase that matched (for the audit issue). */
  requestMatch?: string;
  /** The operational-unblock action phrase that matched (for the audit issue). */
  actionMatch?: string;
}

/**
 * (A) USER-DIRECTED REQUEST markers — the agent asking the OPERATOR to do
 * something. ILLUSTRATIVE of the shape, matched case-insensitively as substrings.
 * Broad on this axis because axis (B) is what makes a match high-precision.
 */
const REQUEST_MARKERS: readonly string[] = [
  'can you',
  'could you',
  'would you',
  'will you',
  'please ',
  "you'll need to",
  'you will need to',
  'you need to',
  'you have to',
  'if you can',
  'if you could',
  'on your end',
  'from your side',
  'on your side',
  'i need you to',
  'i need you',
  'want you to',
  'set me up',
  'grant me',
  'give me access',
  'get me access',
  'you start',
  'you restart',
  'you do it',
  'do it yourself',
  'start it yourself',
  'yourself, or', // "you start it yourself, or set me up..."
  'your call on getting', // "still yours to call on getting Codey back"
  'still yours to',
  'yours to call',
];

/**
 * (B) OPERATIONAL-UNBLOCK ACTION markers — the mechanical thing being deferred,
 * i.e. something an agent with the right access could do itself. Kept to
 * operational verbs so a DECISION deferral ("which do you want") does not match.
 */
const ACTION_MARKERS: readonly string[] = [
  'restart',
  're-start',
  'reboot',
  'kickstart',
  'kick start',
  'start codey',
  'start it',
  'start the',
  'spin up',
  'spin it up',
  'run the',
  'run it',
  'launch',
  'install the',
  'install my',
  'add the key',
  'add my key',
  'drop that key',
  'drop the key',
  'enable ',
  'turn on',
  'flip on',
  'flipped on',
  'log in',
  'log into',
  'grant',
  'access to the',
  'access and',
  'set up access',
  'ssh',
];

/**
 * (C) LEGITIMATE-DEFERRAL overrides — when present, the deferral is a genuine
 * DECISION only the operator can make, or an operator-only CREDENTIAL the agent
 * cannot produce. High-confidence and narrow: a real taste/design/approval call,
 * or a secret only the human holds. When any is present the floor does NOT flag —
 * a genuine question or a true Rung-2 credential ask is not premature deferral.
 */
const LEGIT_OVERRIDES: readonly string[] = [
  'which do you want',
  'which would you',
  'do you want me to',
  'your call on the',
  'your call: ',
  'your decision',
  'up to you which',
  'up to you whether',
  'which approach',
  'which model',
  'auto-climb or',
  'do you approve',
  'approve the',
  'sign off on',
  'are you okay with',
  'is it okay to',
  'okay to proceed',
  'need your password',
  'need a password',
  'your api key',
  'your credential',
  'a secret only you',
  'only you can produce',
];

function firstMatch(haystack: string, needles: readonly string[]): string | undefined {
  for (const n of needles) {
    if (haystack.includes(n)) return n;
  }
  return undefined;
}

/**
 * Detect the premature-deferral shape in an AGENT-OUTBOUND message. Detection
 * requires BOTH a user-directed REQUEST marker AND an operational-unblock ACTION
 * marker, and NO legitimate-deferral override. Pure and synchronous (no LLM).
 */
export function detectDeferralShape(text: string): DeferralFloorResult {
  if (!text) return { detected: false };
  const hay = text.toLowerCase();

  // A genuine decision or an operator-only credential de-fangs the whole message.
  if (firstMatch(hay, LEGIT_OVERRIDES)) return { detected: false };

  const requestMatch = firstMatch(hay, REQUEST_MARKERS);
  if (!requestMatch) return { detected: false };
  const actionMatch = firstMatch(hay, ACTION_MARKERS);
  if (!actionMatch) return { detected: false };

  return { detected: true, requestMatch, actionMatch };
}
