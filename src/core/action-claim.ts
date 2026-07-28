/**
 * action-claim — deterministic classifier for the Action-Claim Follow-Through
 * Sentinel (spec: docs/specs/action-claim-followthrough-sentinel.md).
 *
 * Detects when an outbound message makes a CONCRETE, checkable FUTURE-action claim
 * ("I'll restart it", "relaunching now", "pushing the change") so a follow-through
 * commitment can be registered. Mirrors `time-claim.ts`'s shape: pure, total,
 * first-person scoped, quote-skipping.
 *
 * HIGH PRECISION / FAIL TOWARD NOT-REGISTERING (FD2): unlike time-claim (where a
 * missed claim is a safe under-block), a false action-claim is a durable NAGGING
 * commitment. So we trigger ONLY on a CLOSED set of concrete action verbs, in
 * first-person near-future or present-progressive — never bare "I'll"/"now"/vague
 * "look into". On any ambiguity → not a claim.
 *
 * PAST TENSE is NOT a future-action claim (FD4): "relaunched"/"pushed" is the
 * descoped A2 (completed-action) class — this classifier returns false for it.
 */

export interface ActionClaim {
  /** The concrete action verb, normalized to its canonical lemma (the dedupe anchor). */
  normalizedClaimVerb: string;
  /** The raw matched phrase (for audit). */
  matched: string;
}

export interface ActionClaimResult {
  isActionClaim: boolean;
  claim?: ActionClaim;
}

/**
 * Closed set of CONCRETE, checkable first-person action verbs. Each maps surface
 * forms (incl. present-participle) to a canonical lemma so "restarting"/"restart"
 * collapse for the dedupe key, while distinct actions stay distinct.
 */
// `pattern` = all surface forms (used by the first-person-anchored regexes 1 & 2).
// `participle` = the -ing form ONLY (used by the sentence-initial regex 3, which has
// no explicit subject, so it must be a participle — an imperative base form like
// "Merge the PR" is a command TO the agent, not the agent's own claim).
const VERB_LEMMAS: Array<{ canonical: string; pattern: string; participle: string }> = [
  { canonical: 'relaunch', pattern: 'relaunch(?:ing|es)?', participle: 'relaunching' },
  { canonical: 'restart', pattern: 'restart(?:ing|s)?', participle: 'restarting' },
  { canonical: 'redeploy', pattern: 'redeploy(?:ing|s)?', participle: 'redeploying' },
  { canonical: 'deploy', pattern: 'deploy(?:ing|s)?', participle: 'deploying' },
  { canonical: 'push', pattern: 'push(?:ing|es)?', participle: 'pushing' },
  { canonical: 'merge', pattern: 'merg(?:e|ing|es)?', participle: 'merging' },
  { canonical: 'revert', pattern: 'revert(?:ing|s)?', participle: 'reverting' },
  { canonical: 'rebase', pattern: 'rebas(?:e|ing|es)?', participle: 'rebasing' },
  { canonical: 'rerun', pattern: 're-?run(?:ning|s)?', participle: 're-?running' },
  { canonical: 'fix', pattern: 'fix(?:ing|es)?', participle: 'fixing' },
];

// near-future intent markers that must precede the verb (first-person scoped).
// "I'll restart", "I will push", "I'm going to deploy", "let me rebase",
// "going to merge", "about to redeploy".
const FUTURE_LEAD =
  String.raw`(?:i'?ll|i\s+will|i'?m\s+going\s+to|i\s+am\s+going\s+to|let\s+me|going\s+to|about\s+to|i'?m\s+about\s+to)`;

// present-progressive (FD4): "restarting now", "pushing it", "relaunching" — a
// first-person in-flight claim. We require either a leading "I'm "/"I am " OR a
// trailing " now"/" it"/" the ..." to keep it first-person and avoid matching a
// bare gerund inside unrelated prose.
const PROG_TRAIL = String.raw`(?:\s+(?:now|it|this|that|the\b[^.!?\n]{0,40}))`;

const QUOTE_CHARS = new Set(['"', "'", '“', '”', '‘', '’', '`']);

/** A claim directly preceded by a quote/backtick is being QUOTED, not asserted. */
function isQuoted(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0 && index - i <= 2; i--) {
    const ch = text[i];
    if (ch === ' ') continue;
    return QUOTE_CHARS.has(ch);
  }
  return false;
}

function buildRegexes(): Array<{ canonical: string; re: RegExp }> {
  const out: Array<{ canonical: string; re: RegExp }> = [];
  for (const { canonical, pattern, participle } of VERB_LEMMAS) {
    // future-lead form: "I'll <verb>", "going to <verb>", …
    out.push({
      canonical,
      re: new RegExp(String.raw`\b${FUTURE_LEAD}\s+(?:${pattern})\b`, 'gi'),
    });
    // present-progressive first-person form: "I'm <verb>ing", "I am <verb>ing"
    out.push({
      canonical,
      re: new RegExp(String.raw`\bi'?(?:m|\s+am)\s+(?:${pattern})\b`, 'gi'),
    });
    // SENTENCE-INITIAL present-participle with a binding trailer: "Relaunching now",
    // "Done. Pushing it now." — idiomatically a first-person in-flight claim. MUST be
    // a participle (not a base form) AND at the start of the message or right after a
    // sentence boundary — so it never matches a mid-sentence imperative/question/
    // third-person ("Did you restart it?", "Please merge the PR", "He is deploying it").
    out.push({
      canonical,
      re: new RegExp(String.raw`(?:^|[.!?]\s+)(?:${participle})${PROG_TRAIL}`, 'gi'),
    });
  }
  return out;
}

const REGEXES = buildRegexes();

// Past-tense guard (FD4): a clear past-tense form is the descoped A2 class, never
// a future-action claim. We reject a match whose verb appears ONLY in past tense.
const PAST_RE =
  /\b(?:relaunched|restarted|redeployed|deployed|pushed|merged|reverted|rebased|re-?ran|fixed)\b/i;

/**
 * Classify an outbound message. Returns the FIRST concrete future-action claim
 * (high-precision; fail toward not-registering). Pure + total.
 */
export function classifyActionClaim(text: string): ActionClaimResult {
  if (!text || typeof text !== 'string') return { isActionClaim: false };
  let best: { index: number; canonical: string; matched: string } | null = null;
  for (const { canonical, re } of REGEXES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isQuoted(text, m.index)) continue;
      // The matched span itself must not be a past-tense assertion.
      if (PAST_RE.test(m[0])) continue;
      if (best === null || m.index < best.index) {
        best = { index: m.index, canonical, matched: m[0].trim() };
      }
    }
  }
  if (!best) return { isActionClaim: false };
  return {
    isActionClaim: true,
    claim: { normalizedClaimVerb: best.canonical, matched: best.matched },
  };
}
