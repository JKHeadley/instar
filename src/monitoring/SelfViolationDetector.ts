/**
 * SelfViolationDetector — turns a self-violation into a LEARNING SIGNAL.
 *
 * The motivating problem (Correction & Preference Learning Sentinel, Self-Violation
 * Signal extension): a stored preference (e.g. "don't defer work to a fresh
 * session", "never ask the user to edit files") is recalled every session yet
 * still gets VIOLATED — and the violation just evaporates with no structural
 * consequence. This detector OBSERVES the agent's own finalized outbound message
 * and reports which stored preferences it contradicts, so the wiring seam can
 * record the violation in the CorrectionLedger and reinforce the matched
 * preference's recurrence/salience for the next session.
 *
 * ABSOLUTE CONSTRAINTS (spec §3.9 + the user's explicit hard rule):
 *   1. SIGNAL-ONLY — this module OBSERVES and RETURNS a list. It never blocks,
 *      delays, rewrites, or alters an outbound message. It holds no authority.
 *   2. PRECISION OVER RECALL — a lone weak/ambiguous match must NOT fire. A false
 *      self-violation that nags is the bad direction, so the match contract is
 *      deliberately conservative (explicit per-preference pattern, never a fuzzy
 *      heuristic the LLM or the loop can widen).
 *   3. NEVER THROWS — a malformed pattern, bad input, or any internal error is
 *      guarded internally and yields an empty result. A detector error must
 *      never propagate to the message-delivery seam (fail-open is enforced both
 *      here and at the caller).
 *
 * Back-compatibility: a preference WITHOUT a `violationPattern` is simply never
 * self-violation-checked. Shipped `.instar/preferences.json` files (which have no
 * such field) are fully compatible — they produce zero detections.
 */

import type { PreferenceEntry } from '../core/PreferencesManager.js';

/** A preference that the outbound message was found to contradict. */
export interface SelfViolation {
  /** The preference that was violated. */
  preference: PreferenceEntry;
  /** The literal substring of the outbound message that triggered the match. */
  matchedText: string;
  /**
   * How the match was made — 'regex' (the pattern was a valid RegExp source) or
   * 'keywords' (the pattern was a keyword set; ALL keywords had to be present).
   */
  matchKind: 'regex' | 'keywords';
}

/** Result of a single-preference check (internal). */
interface SinglePatternResult {
  matched: boolean;
  matchedText: string;
  matchKind: 'regex' | 'keywords';
}

// Cap on the length of a candidate message we will scan. A pathological
// multi-megabyte outbound would otherwise let a catastrophic-backtracking regex
// burn CPU; precision-over-recall means we only ever need the leading content.
const MAX_SCAN_CHARS = 20_000;

// A keyword pattern (the `keywords:` form) requires at least this many distinct
// keyword tokens to fire — a lone weak keyword must never trip a violation
// (precision over recall). A single-keyword pattern is treated as too weak to
// fire on its own and is skipped.
const MIN_KEYWORDS_TO_FIRE = 2;

/**
 * Detect which of the supplied active preferences the outbound message violates.
 *
 * Pure, deterministic, precision-biased, and guaranteed never to throw. Returns
 * the list of violated preferences (empty when none, or on any error, or when no
 * preference carries a `violationPattern`).
 *
 * Pattern grammar for `preference.violationPattern`:
 *   - `regex:<source>`  → compiled as a case-insensitive RegExp; a match fires.
 *   - `keywords:a,b,c`  → fires only when ALL of the comma-separated keywords
 *                          appear (case-insensitively) in the message AND there
 *                          are at least MIN_KEYWORDS_TO_FIRE of them (a lone
 *                          keyword never fires).
 *   - bare `<source>`   → treated as a regex source (back-compat / convenience).
 *
 * An empty/whitespace pattern, an unparseable regex, or a single-keyword set is
 * treated as "no check" for that preference (skipped, never an error).
 */
export function detectSelfViolation(
  outboundText: string,
  activePreferences: PreferenceEntry[] | null | undefined,
): SelfViolation[] {
  try {
    if (typeof outboundText !== 'string' || outboundText.length === 0) return [];
    if (!Array.isArray(activePreferences) || activePreferences.length === 0) return [];

    // Scan a bounded prefix only (precision over recall — and a CPU guard).
    const haystack = outboundText.length > MAX_SCAN_CHARS
      ? outboundText.slice(0, MAX_SCAN_CHARS)
      : outboundText;

    const violations: SelfViolation[] = [];
    for (const pref of activePreferences) {
      if (!pref || typeof pref !== 'object') continue;
      const pattern = (pref as PreferenceEntry).violationPattern;
      // Absent / empty pattern ≡ this preference is never self-violation-checked.
      if (typeof pattern !== 'string' || pattern.trim().length === 0) continue;

      const result = matchPattern(haystack, pattern);
      if (result.matched) {
        violations.push({
          preference: pref as PreferenceEntry,
          matchedText: result.matchedText,
          matchKind: result.matchKind,
        });
      }
    }
    return violations;
  } catch {
    // @silent-fallback-ok — a detector error must NEVER reach the delivery seam.
    return [];
  }
}

/** Evaluate ONE preference's pattern against the (bounded) message. Never throws. */
function matchPattern(haystack: string, rawPattern: string): SinglePatternResult {
  const miss: SinglePatternResult = { matched: false, matchedText: '', matchKind: 'regex' };
  try {
    const pattern = rawPattern.trim();
    if (pattern.length === 0) return miss;

    if (pattern.toLowerCase().startsWith('keywords:')) {
      return matchKeywords(haystack, pattern.slice('keywords:'.length));
    }

    // `regex:<source>` or a bare source (back-compat convenience).
    const source = pattern.toLowerCase().startsWith('regex:')
      ? pattern.slice('regex:'.length)
      : pattern;
    return matchRegex(haystack, source);
  } catch {
    // @silent-fallback-ok — an unparseable / pathological pattern is a no-check.
    return miss;
  }
}

/** Compile and test a regex source (case-insensitive). Never throws. */
function matchRegex(haystack: string, source: string): SinglePatternResult {
  const miss: SinglePatternResult = { matched: false, matchedText: '', matchKind: 'regex' };
  const trimmed = source.trim();
  if (trimmed.length === 0) return miss;
  let re: RegExp;
  try {
    re = new RegExp(trimmed, 'i');
  } catch {
    // @silent-fallback-ok — invalid regex source ≡ no check for this preference.
    return miss;
  }
  const m = re.exec(haystack);
  if (!m) return miss;
  return { matched: true, matchedText: m[0].slice(0, 200), matchKind: 'regex' };
}

/**
 * Keyword-set match: fires only when ALL keywords are present AND there are at
 * least MIN_KEYWORDS_TO_FIRE distinct keywords (a lone weak keyword never fires —
 * precision over recall). Matching is case-insensitive substring presence.
 */
function matchKeywords(haystack: string, rawKeywords: string): SinglePatternResult {
  const miss: SinglePatternResult = { matched: false, matchedText: '', matchKind: 'keywords' };
  const keywords = rawKeywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
  // De-duplicate so "fresh,fresh" can't masquerade as two keywords.
  const distinct = Array.from(new Set(keywords));
  if (distinct.length < MIN_KEYWORDS_TO_FIRE) return miss; // lone keyword never fires

  const lowerHay = haystack.toLowerCase();
  for (const kw of distinct) {
    if (!lowerHay.includes(kw)) return miss; // ALL must be present
  }
  // Report the keyword set as the matched signal (no raw-message substring needed).
  return { matched: true, matchedText: distinct.join(' + ').slice(0, 200), matchKind: 'keywords' };
}
