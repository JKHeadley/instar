# Side-Effects Review — document tables render as real tables

**Version / slug:** `doc-tables-141469`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1 (small, reversible, behind the existing `documents.enabled` dark gate). 4 files, about 110 lines. One commit attempt before this artifact (the trace gate refused it, as expected); no spec review rounds (Tier 1, PR is the review surface). The Instar Documents page (`/docs/:id`) showed every markdown table row as one monospace line of text with ` | ` between the cells, so a table read as a block of bars (operator report, topic 141469, 2026-11-17 12:25 PST, with a photo of the page). Now:

- `src/documents/render.ts`: a table row's runs carry `cell` (the column index) and the ` | ` joiner runs carry `sep: true`; the row block carries `align` (each column's alignment from the delimiter row). The text of every run is unchanged, so the render tree still equals the plain-text projection character for character (the existing equality check in `renderTree` and the fuzz test still hold) and every comment offset stays where it was.
- `dashboard/docs/doc-page.js`: `renderRow` builds a real `<table>` (header row in `<thead>` with `th scope=col`, body rows in `<tbody>`), puts each run in the cell its `cell` index names (so an empty cell stays empty and the columns line up), applies the column alignment, and does not show the joiner runs. Text nodes are still registered in `textStart`/`state.textNodes` in document order, so selection → offset mapping, highlights and the Comment pill work as before. A row from an older server (no `align`) falls back to the old one-line rendering.
- `dashboard/docs/doc-page.css`: the table sits in a bordered box that scrolls sideways on its own when wider than the screen; the page itself never scrolls sideways.
- `tests/unit/documents-render.test.ts`: pins the new fields, including an empty first cell, and that non-table blocks carry none of them.

## Decision-point inventory

No decision-point surface. This is presentation of already-authorized content; no gate, filter, access check or block/allow logic is touched.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Rendering gaps that remain: a cell's inline image still shows as its alt text (same as everywhere else on the page, by design: the page never loads document images), and a table nested inside a list item renders as a table at the list's position without the list indent.

---

## 3. Level-of-abstraction fit

Right layer. The server already owns the parse (the page never parses markdown, spec §3.5) so the column structure is added there as typed metadata on the existing runs; the page only lays it out. Doing the column split in the page by searching for ` | ` would break on empty cells (whitespace collapse turns the joiner into `| `) and on escaped pipes inside a cell, which is why the column index comes from the server.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added or changed. Rendering only.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point — not applicable.

---

## 5. Interactions

- Projection / anchoring: unchanged text, so `projectText`, comment anchors, re-anchoring and the version diff are unaffected; the `renderTree` self-check would throw (a 500, never a misplaced comment) if that ever changed.
- Selection across cells: the browser's own selection string uses tabs between cells, but the page cuts quotes from the projection (`state.projection.slice`), so a quote reads "Studio | lease", exactly as the server stores it.
- The iPhone app shows this same page in its web view, so the app gets the fix with no app change.
- Open PR #3317 (Approve and Decline on documents) touches the same two page files in different functions (`renderBlocks` is shared: I add a `table` local and an early branch for rows at the top of its loop). A textual merge conflict is possible at most there; no behavioural overlap.

---

## 6. External surfaces

The `GET /docs/:id/page-data` block shape gains optional fields (`align` on rows; `cell`, `sep` on row runs). Additive: an older page ignores them; a newer page against an older server falls back to the old row rendering. No other consumer reads `blocks` (the app reads the page, not the JSON). Visible change: only to people who open a document containing a table, on agents where documents are switched on (development agents today).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The page's primary action (reading and selecting text to comment) is unchanged; tables now read as tables in the reading flow.
2. **Zero raw internals as primary content?** Yes. Tables show only the document's own cell text; the internal joiners are no longer shown.
3. **Destructive actions de-emphasized?** No destructive action on this surface — not applicable to this change.
4. **Plain language + phone width?** Yes. Verified in headless Chromium at 390x844 and 1280x728, light and dark: the page's scroll width equals the viewport width (390/390, 1280/1280); a wide table scrolls sideways inside its own bordered box, a narrow one fits; header row shaded and bold; column alignment from the delimiter row honoured; an empty cell stays empty in its column.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the render tree is computed on read from the document's markdown, which already replicates through the existing documents sync. Every machine that serves the page computes the same tree from the same markdown. No new state, notices or URLs.

**Status surfaces:** none added or changed.

---

## 8. Rollback cost

A revert of this commit. No stored data, config or migration; the new fields are computed per request.

---

## Conclusion

Safe, presentation-only, Tier 1. Ships behind the existing documents switch.

---

## Second-pass review (if required)

**Reviewer:** not required (no gate, sentinel, session lifecycle or messaging decision touched)

---

## Evidence pointers

- `tests/unit/documents-render.test.ts` — new case "tags table runs with their column and the joiner, and carries the column alignment"; the existing 400-document fuzz and the render/projection equality still pass.
- `tests/unit/documents-page-model.test.ts`, `tests/unit/documents-projection.test.ts` — pass unchanged (45 tests across the three files).
- Headless Chromium run of the shipped `doc-page.js` + `doc-page.css` against a `page-data` built by the real `renderTree`: screenshots at phone and computer width, light and dark; selection from cell 1 into cell 2 of a row maps through the text nodes.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (A rendering gap in shipped page code, not a prompt, hook, config, skill or standards text.)
