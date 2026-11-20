# Side-Effects Review — reworded passages show whole words

**Version / slug:** `doc-reanchor-whole-words-141469`
**Date:** `2026-11-20`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog, messaging or session-lifecycle surface)`
**Tier:** 1 (1 source file, 1 test file, 1 proof script; about 90 lines; reversible by revert). Effort: 0 spec rounds, first commit attempt.

## Summary of the change

Found by the Instar Documents browser live proof (topic 141469): after a passage was reworded from "first business day of each month" to "second business day of each month", the comment's "Now reads" line showed "econd business day of each month". The fuzzy step in `reanchorUnsafe` (Bitap + semi-global edit distance) prefers the cheaper alignment, and dropping the leading "s" is one edit cheaper than inserting it.

- `src/documents/anchor.ts`: new `snapToWords(oldText, anchor, newText, start, end)`. If the original selection's start was on a word edge in the old text (not between two word characters), the new start moves left while it sits between two word characters (letters, numbers, marks, underscore), at most 64 steps. The same applies to the end, moving right. It is applied to the short-quote fuzzy result (state recomputed from the widened text) and to the long-quote head/tail result. The exact-match path is untouched.
- `tests/unit/documents-anchor.test.ts`: 4 cases (first word kept; last word kept; a mid-word selection is not widened; determinism).
- `scripts/documents-live-proof.ts`: the narrow tab is a narrow computer window (no `hasTouch`), since #3216 rightly gives a touchscreen phone the app offer. New scenario `hp-phone-browser-offers-the-app` (touch + isMobile at 390×844: "Open in the Instar app", no `.link-fingerprint`, zero `/docs/_link/nonce` requests). The anchors scenario reads the #3462 heading "Not in this version", accepts either deleted-passage note, and asserts "Now reads: second business day of each month".

## Decision-point inventory

None. Where a comment is drawn and what its "Now reads" line says is presentation. Nothing is blocked, filtered or allowed. Access and writes are unchanged.

## 1. Over-block

Nothing is rejected. The only new behaviour is a wider match, so the case to consider is over-widening. It is bounded: it fires only on an edge where the original selection was on a word edge, only while the new edge sits inside a word, and stops after 64 characters. The worst case is a "Now reads" line that includes a whole long word.

## 2. Under-block

A reword that changes the word boundary itself (for example "first-day" to "firstday") may still show a partial word on the other side of punctuation; `_` and letters count as word characters, `-` does not. Astral-plane letters (outside the BMP) are not treated as word characters, so widening stops at them rather than splitting a surrogate pair. Neither case is a regression.

## 3. Level-of-abstraction fit

Right layer: `anchor.ts` owns placement and already returns `exact` for "Now reads". Fixing it here fixes the page, the agent API's comment list and the session context in one place.

## 4. Signal vs authority compliance

No authority added (docs/signal-vs-authority.md). Placement is a derived projection with no gating role.

## 5. Interactions

`placeComment` in `src/documents/service.ts` consumes `start`, `end` and `exact`, and the page highlights `start..end`. The widened range is still a valid range of the new projection, so highlighting is unaffected. `verifyQuote` (the write check) is untouched. The state may become `ok` if widening recovers the exact original text. That is correct: the passage is unchanged.

## 6. External surfaces

None beyond the document page's "Now reads" text and highlight extent, and the same fields in `GET /docs/:id/comments`. Dark on the fleet (documents ship dark).

## 7. Multi-machine posture

Machine-local by design and deterministic: placement is recomputed from the replicated document stream on every read. Two machines on different instar versions could briefly draw a reworded comment's edge differently (one with, one without the first letter). That is cosmetic and converges when both update. Nothing is stored.

## 8. Rollback cost

Revert the commit. No state, migration or config.

## Evidence

See `upgrades/next/doc-reanchor-whole-words-141469.md`: the unit test fails on main and passes with the fix; 234/234 document unit tests; browser live proof PASS 30 / FAIL 0 / BLOCKED 5 on main d9117905 plus this change.
