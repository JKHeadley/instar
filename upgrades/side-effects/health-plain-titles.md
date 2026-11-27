# Side-Effects Review — each unsorted health problem gets its own plain title and plain words

**Version / slug:** `health-plain-titles`
**Date:** `2026-11-06`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, display only. In `src/monitoring/healthIssues.ts`:
- `summarizeHealth` titles rows that no rule names with `plainTitleFor` instead of a shared catch-all.
- Their evidence goes through `plainEvidence`, after the existing secret and path scrubbing.
- Duplicate titles among unnamed rows get a tag.

New exports: `SUBSYSTEM_NAMES`, `isPlainWords`, `plainTitleFor`, `plainEvidence`. The events the routes pass already include `impact`, so no wiring changes. Rule rows are unchanged.

Asked for by Justin in topic 134088, 2026-11-06 22:49 PST.

## Decision-point inventory

No decision-point surface: only display wording. Impact sorting, counts, choices and hiding are unchanged.

---

## 1. Over-block

No block/allow surface. The evidence filter can leave out a reporter's text that was actually readable but contained a word like "refused" or "spawn". The row then shows no "in the agent's words" line, and Ask still covers it.

## 2. Under-block

No block/allow surface. A reporter's impact line that is plain but vague can become a title. It is limited to 2–8 plain words.

## 3. Level-of-abstraction fit

This sits in the same pure summarizer that owns the titles, so the phone and the dashboard both get it from `GET /mobile/health-issues`.

## 4. Signal vs authority compliance

Not a decision point.

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no judgment point: deterministic mapping and fallback, with no LLM.

## 5. Interactions

- **Choices** bind to `keys` (ids), not titles, so hide/snooze rows still match.
- **Ask** text is rebuilt with the final title.
- **Grouping** by rule key is unchanged.

## 6. External surfaces

- Title and evidence strings in `GET /mobile/health-issues` change for rows no rule names.
- Apps and the dashboard display them as sent; nothing parses them.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This is the improvement itself: each row says what it is about, with no internal jargon.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, unchanged: each machine's reading of its own /health.

## 8. Rollback cost

Pure code: revert and ship a patch. There is no state.

---

## Conclusion

Clear to ship.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/mobile-health-issues.test.ts`
- `tests/unit/console-health.test.ts`
- `tests/unit/health-choices.test.ts`

89 pass.

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a` (negative declaration)
- **reason:** no action is taken. The change only produces display strings; words like "spawn" and "restart" appear as text in the plain-words filter and in titles, not as calls.
