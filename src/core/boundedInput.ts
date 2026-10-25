/**
 * boundedInput — bound a value that is about to become the INPUT to a judgment,
 * and tell the judge that you did.
 *
 * ── Which standard rules this file ───────────────────────────────────────
 * *Never Silently Cut the Data a Decision Depends On*
 * (docs/STANDARDS-REGISTRY.md), a named subsection of *Verify the State, Not
 * Its Symbol*. Its sibling *Expected Capacity Enforcement Is an Outcome, Not a
 * Degradation* governs the STORAGE side (applying a declared budget to a record
 * you are keeping is a success, not a fault); this file is the INPUT side (a
 * bound applied to data a decision is about to be made from).
 *
 * ── Why a helper rather than a rule people follow ────────────────────────
 * `text.slice(0, N)` is one keystroke shorter than doing this correctly, always
 * available, and looks finished. Every site that reached for it produced the
 * same three defects, so the fix is a function that makes the correct version
 * the easy one (*Structure beats Willpower*):
 *
 *  1. **Direction.** For anything assembled chronologically — a conversation, a
 *     log, a transcript — `slice(0, N)` keeps the OLDEST content and discards
 *     the newest. That is backwards for nearly every judgment made about such
 *     data, and it fails invisibly because the retained head still reads like
 *     ordinary content. `boundedTail` keeps the end; `boundedHead` keeps the
 *     start, and exists so that choosing the head is a choice a reader can see
 *     being made rather than a default nobody noticed.
 *
 *  2. **Disclosure to the CONSUMER, in-band.** A model handed a fragment with
 *     no marker cannot tell it received a fragment. It answers confidently
 *     about the part it can see. Logging the truncation does not help it — the
 *     log is read later, by someone else, if at all. The marker goes into the
 *     value itself, at the cut, saying which direction was lost and how much.
 *
 *  3. **A derived bound.** These helpers cannot check that the caller's number
 *     is well chosen; that stays a reading. What they do enforce is that a
 *     number too small to hold the marker is REFUSED rather than silently
 *     producing a value that is nothing but marker.
 *
 * ── What this does NOT do ────────────────────────────────────────────────
 * It does not decide whether the operation may proceed on a bounded view. That
 * is the caller's judgment, and where the dropped part is load-bearing the
 * standard requires a REFUSAL, not a marker — see the load-bearing refusal in
 * `crossModelReviewer.runCrossModelReview` for the shape. A marker says "your
 * view is partial"; it never makes a partial view sufficient.
 */

/**
 * The in-band disclosure. Deliberately verbose and deliberately English: the
 * consumer is usually a model, and `...` is ambiguous (an ellipsis appears in
 * ordinary prose). It names the DIRECTION of the loss, because "some of this is
 * missing" and "the beginning of this is missing" support different answers.
 */
function marker(omittedChars: number, side: 'leading' | 'trailing'): string {
  const where = side === 'leading'
    ? 'EARLIER content was omitted, so this begins mid-way'
    : 'LATER content was omitted, so this stops before the end';
  return `[BOUNDED INPUT: ${omittedChars} characters removed to fit a size limit — ${where}. Your view of this section is PARTIAL; do not treat its absence of something as evidence that it is absent.]`;
}

/** Longest marker this module can emit, used to reject a bound too small to disclose in. */
const MAX_MARKER_CHARS = Math.max(
  marker(999_999_999, 'leading').length,
  marker(999_999_999, 'trailing').length,
);

/**
 * Reject a bound that cannot hold its own disclosure. A caller who asks for 40
 * characters would otherwise receive a value that is entirely marker and no
 * content — which reads as a working bound and conveys nothing. Failing loudly
 * at the call site is the only outcome that gets it fixed.
 */
/**
 * The smallest retention that is guaranteed to leave content after surrogate
 * trimming at both edges. See trap (b) in `assertBoundIsUsable`.
 */
const MIN_CONTENT_CHARS = 3;

function assertBoundIsUsable(maxChars: number): void {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new RangeError(`boundedInput: maxChars must be a positive finite number (got ${maxChars})`);
  }
  // Room for the marker, the newline that separates it from content, AND enough
  // content that at least one character SURVIVES surrogate trimming.
  //
  // Two separate traps, both found by tests rather than in production:
  //
  // (a) At exactly marker+1 the retained slice is `slice(-0)`, which is
  //     `slice(0)` — the WHOLE string — so the bound would be silently exceeded
  //     by the one function whose entire job is to hold a bound.
  //
  // (b) One reserved character is still not enough (independent review
  //     2026-08-22, finding C7). `trimLoneSurrogates` drops up to one code unit
  //     at EACH edge, so a 1- or 2-unit retention of astral text can be trimmed
  //     to nothing and the result is 100% marker and 0% content — precisely the
  //     outcome this guard's own docblock promises to prevent. Three units is
  //     the smallest retention that survives both edges: the worst case
  //     [low, X, high] loses both ends and still leaves `X`.
  if (maxChars < MAX_MARKER_CHARS + MIN_CONTENT_CHARS + 1) {
    throw new RangeError(
      `boundedInput: maxChars ${maxChars} is too small to hold the truncation disclosure ` +
        `(needs >= ${MAX_MARKER_CHARS + MIN_CONTENT_CHARS + 1}). A bound that cannot disclose its own cut is the defect ` +
        `this helper exists to prevent — raise the bound rather than lowering the disclosure.`,
    );
  }
}

/**
 * Drop a dangling half of a surrogate pair at either edge of a slice.
 *
 * JavaScript slices strings by UTF-16 code unit, so a cut can land in the middle
 * of an astral character (an emoji, most CJK extension characters) and leave a
 * lone surrogate. That is not merely cosmetic when the consumer is a CLI reached
 * over a pipe: a lone surrogate has no valid UTF-8 encoding, so it becomes a
 * replacement character or, on a strict decoder, an error — turning a bounded
 * input into a malformed one. Dropping at most one code unit per edge is
 * cheaper than every downstream consumer having to tolerate it.
 */
function trimLoneSurrogates(s: string): string {
  let out = s;
  // A leading LOW surrogate lost its HIGH half to the cut.
  if (out.length > 0) {
    const first = out.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
  }
  // A trailing HIGH surrogate lost its LOW half to the cut.
  if (out.length > 0) {
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out;
}

/**
 * Keep the END of `text`, bounded to `maxChars` INCLUDING the disclosure.
 *
 * The default for chronological data — a conversation history, a session
 * transcript, a log tail — where the most recent content is the evidence and
 * the oldest is preamble.
 *
 * Returns `text` unchanged when it already fits, so a marker in the output is
 * always a true statement that something was cut.
 */
export function boundedTail(text: string, maxChars: number): string {
  assertBoundIsUsable(maxChars);
  if (text.length <= maxChars) return text;
  // Reserve room for the marker + the newline that separates it from content.
  const kept = trimLoneSurrogates(text.slice(-(maxChars - MAX_MARKER_CHARS - 1)));
  return `${marker(text.length - kept.length, 'leading')}\n${kept}`;
}

/**
 * Keep the START of `text`, bounded to `maxChars` INCLUDING the disclosure.
 *
 * Correct when the beginning genuinely carries the meaning — a document title
 * and abstract, a structured record whose head is its identity. Wrong for
 * anything chronological. Named separately from `boundedTail` so that choosing
 * it is legible as a decision in review.
 */
export function boundedHead(text: string, maxChars: number): string {
  assertBoundIsUsable(maxChars);
  if (text.length <= maxChars) return text;
  const kept = trimLoneSurrogates(text.slice(0, maxChars - MAX_MARKER_CHARS - 1));
  return `${kept}\n${marker(text.length - kept.length, 'trailing')}`;
}

/**
 * The smallest bound these helpers will accept: room for the disclosure, its
 * separating newline, and enough content to survive surrogate trimming at both
 * edges. Exposed so a caller deriving its own number can check it against the
 * floor rather than discovering the refusal at runtime.
 */
export const BOUNDED_INPUT_MIN_CHARS = MAX_MARKER_CHARS + MIN_CONTENT_CHARS + 1;
