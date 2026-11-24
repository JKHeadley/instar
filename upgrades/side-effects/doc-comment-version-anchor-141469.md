# Side-Effects Review — document comments stay on the version they were made on

**Version / slug:** `doc-comment-version-anchor-141469`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1 (small, reversible, behind the existing `documents.enabled` dark gate). 11 files, about 130 lines changed plus tests. No spec review rounds (Tier 1, the PR is the review surface); the existing spec's §3.5 is updated to describe the behaviour. Operator report, Telegram topic 141469, 2026-11-18 13:31 PST: a highlight made on version 1 moved to an unrelated section in version 2, and the card quoted the new text. Two causes, both fixed:

- `src/documents/anchor.ts` (`reanchor`, step 1 "exact with context"): a single exact occurrence of the quote anywhere in the new version was accepted as `ok` with no check that it was the same passage, and proximity alone (within a 2,000-character range) could carry a match in a short document. Now an exact occurrence is a candidate only if it starts within 8 characters of the position the version diff maps the old start to, or at least 12 characters of the stored prefix/suffix still sit next to it. If occurrences exist but none qualifies, the comment is `orphaned` straight away (a fuzzy search near the mapped position would just find those same words). The existing scoring and 25% lead rule then choose among qualifying candidates, unchanged.
- `src/documents/service.ts` (`placeComment`/`comments`): the returned `quote` was replaced by the re-anchored text when a passage was `edited`. It is now always the text the person highlighted; the new wording is returned separately as `nowReads`. `comments()` takes an optional `versionId` and places comments on that version (default stays the latest, so `GET /docs/:id/comments` for the agent is unchanged in placement); each comment also carries `onVersionLabel`.
- `src/server/documentPageRoutes.ts`: `page-data?version=` now asks for comments placed on the version being read.
- `dashboard/docs/doc-page-model.js` / `doc-page.js`: highlights render on any version (they used to be suppressed on every version but the latest); the card shows "Made on version N" when reading another version, "Now reads: …" for a reworded passage, and "Open version N" for a comment whose passage is not in the version being read; the orphan heading reads "Not in this version"; the older-version banner says comments show only where their passage is.
- `dashboard/docs/doc-page.css`: in the computer-width margin layout, the absolute-positioning rule matched the orphan list too (it also has class `thread-list`), so its cards left the page flow and hung below the page behind the Send bar, untappable. Found by the headless check of this change; scoped to `.thread-list:not(.static)`.
- `docs/specs/instar-document-viewer.md` §3.5 and `src/data/awareness/instar-documents.md`: describe the new rule and fields.

## Decision-point inventory

No decision-point surface. Comment placement is presentation of already-authorized content; no access check, gate, filter or block/allow logic is touched. Writes (new comments, re-anchor) are unchanged and still latest-version only.

---

## 1. Over-block

No block/allow surface — not applicable. The closest analogue: a comment that is now `orphaned` on a newer version although a human would say it survived. That needs the quote to have moved away from its diff-mapped spot AND lost almost all of its 48-character context on both sides; the comment is still listed, with its original quote and a button to its own version, and its author can re-attach it (`comment-reanchor`), so nothing is lost.

---

## 2. Under-block

No block/allow surface. Remaining placement limits: a short quote whose own words survive at the mapped spot but whose meaning changed is still shown `ok` (the same as before); fuzzy matches (step 2) are unchanged and still limited to ±2,000 characters of the mapped position with similarity ≥ 0.75.

---

## 3. Level-of-abstraction fit

Right layer. The anchoring rule lives in the pure, deterministic `reanchor` (every machine places a comment identically); the original-quote rule lives in the service that assembles comments for both the agent and the page; the page only renders the fields. Doing either in the page would leave the agent's comment read wrong.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added or changed. Placement only.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point — not applicable. The placement thresholds are deterministic by design (spec §3.5: identical placement on every machine, no model in the loop).

---

## 5. Interactions

- `comment-reanchor` (author moves own comment): unchanged; still offered only on the latest version, and a re-anchored comment's `onVersion` becomes the version it was moved on.
- Send and the agent's comment read: they cover the same comments; the quote they carry is now the original highlighted text, which is what spec §3.5 item 3 already promised for orphaned comments.
- Approve/Decline (#3317) touches the same page files in different functions; no overlap in behaviour.
- The iPhone app shows this same page in its web view, so it gets the change with no app change; the app's native comment sheet still cuts its quote from the latest projection, as before.
- Property test (300 seeded random edits, never throws, deterministic) passes with the new rule.

---

## 6. External surfaces

`GET /docs/:id/page-data` and `GET /docs/:id/comments` comment objects gain optional `nowReads` and `onVersionLabel`; `quote` now always holds the originally highlighted text instead of the re-anchored text for `edited` comments. Additive for readers; an older page ignores the new fields. `page-data?version=` now returns comments placed on that version (start/end relative to it) instead of the latest; the only reader is the page, which is updated in the same change. Visible change only to people who open a revised document with comments, on agents where documents are switched on (development agents today).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. Reading and commenting are unchanged; the card's new line tells you which version a comment belongs to, and the one action for a comment not in this version ("Open version N") is on the card itself.
2. **Zero raw internals as primary content?** Yes. Version labels and the person's own words only; no ids or states.
3. **Destructive actions de-emphasized?** No destructive action added — not applicable.
4. **Plain language + phone width?** Yes. Headless Chromium at 390x844 and 1280x728 against page data built by the real service: page scroll width equals viewport width (390/390, 1280/1280); the "Open version 1" button is not covered by the Send bar at either size and opens version 1, where both comments are highlighted at their original places.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: placement is computed on read from the replicated document rows (versions, comments, anchor blobs), deterministically, so every machine serving the page shows the same placement. No new state, notices or URLs.

**Status surfaces:** none added or changed.

---

## 8. Rollback cost

A revert of this commit. No stored data, config or migration; placement and the new fields are computed per request.

---

## Conclusion

Safe, presentation and placement only, Tier 1. Ships behind the existing documents switch. Proportion: one commit attempt so far; the browser check found and fixed one adjacent layout defect that would otherwise have hidden the new button.

---

## Second-pass review (if required)

**Reviewer:** not required (no gate, sentinel, session lifecycle or messaging decision touched)

---

## Evidence pointers

- `tests/unit/documents-anchor.test.ts` — "the same words left only in an unrelated section…", "in a short document, the same words in a nearby unrelated section…" (both fail on main), "the same words still in place with changed surroundings → ok"; the existing 300-seed property test passes.
- `tests/unit/documents-service.test.ts` — "a comment stays on the version it was made on, quotes the original text, and never jumps to unrelated words" (fails on main), "an edited passage keeps the original quote…".
- `tests/unit/documents-page-model.test.ts` — highlights on any version; "Made on version N" notes.
- `tests/integration/documents-page.test.ts` — "page data places comments on the version being read…": a device-signed comment on version 1, a version 2 that keeps the words only in an unrelated note; `page-data` shows it orphaned with the original quote, `page-data?version=<v1>` shows it at its original offsets. (The server file carries an E2E-PAIRING exemption: page-data needs a phone-minted read cookie that the production-path e2e cannot mint.)
- All document unit tests (213), `tests/integration/documents-page.test.ts`, `documents-routes.test.ts`, `tests/e2e/documents-alive.test.ts` pass. `tests/unit/documents-qr.test.ts` cannot load on this machine (its `jsqr` test dependency is not installed here); it does not touch this code.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (A placement defect in shipped document code, not a prompt, hook, config, skill or standards text.)
