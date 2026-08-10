/**
 * invisible-payload.ts — the single definition of "this message has nothing a human can see".
 *
 * Extracted 2026-08-09 because review pass 9 found the regression test had its OWN copy of the
 * predicate: deleting the guard from the route would have left the test green. A test that cannot
 * fail when the thing it guards is removed is the *alive-but-inert* shape in test form — it reports
 * identically whether or not the protection exists. One definition, imported by both.
 *
 * The rule itself is Unicode's, not a hand-written list. An earlier version enumerated five code
 * points and pass 8 immediately produced five more it missed (U+200E, U+2061, U+FE0F, U+00AD,
 * U+180E), so "invisible payloads are refused" was true of the incident and false as a claim.
 * `Default_Ignorable_Code_Point` is the standard's own category for characters that render as
 * nothing; `Cf` is format controls.
 *
 * Earned from a live incident: a peer agent's relay accepted a send whose entire body was one
 * ZERO-WIDTH SPACE, failed with a 500 carrying an EMPTY error body, burned nine retries across
 * 4h17m, and emitted a user-facing "I had a reply for you but couldn't deliver it" notice. There
 * was no reply.
 *
 * **What this does NOT decide:** whether a visible message is *worth* sending. It answers exactly
 * one question — is there anything here a reader could see — and a message consisting of a single
 * full stop passes, correctly.
 */

/** Unicode whitespace plus every character the standard classes as rendering to nothing. */
const INVISIBLE_RE = /[\s\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

/**
 * True when `text` contains no visible characters — only whitespace and/or marks that render as
 * nothing. Callers refuse such a payload rather than sending it.
 */
export function hasNoVisibleCharacters(text: string): boolean {
  return text.replace(INVISIBLE_RE, '').length === 0;
}
