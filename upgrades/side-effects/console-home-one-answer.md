# Side-effects review — Console Home: one answer to "what needs you"

**Version / slug:** `console-home-one-answer`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Operator report (topic 127504): the console Home headline said "One thing needs you." while the "What needs you" card said "Nothing needs you", and the card printed "No answer from m_a804869356b259820b3236e7c5a2ae7d. 420 routine notices kept in the log." Cause: `headline()` summed attention items needing the operator plus promises waiting on the operator; the card counted only the attention queue. Fix: `combineNeeds()` folds waiting promises into the card and `headline()` counts the combined card alone; machines are named from `/pool` or described ("a machine with no name on file"), never shown by id; internal wording replaced. A new unit test scans every Home builder's rendered text for raw ids, placeholders and known internal phrases.

Tier 1 (dashboard display only; a revert fully undoes it). Size: 2 dashboard files (~90 LOC), 1 new test file, 1 test file updated. Effort: no spec review rounds (Tier 1), first commit attempt.

## Decision-point inventory

None. The console Home is a read-only view; nothing here gates, blocks or filters any message or action.

## 1. Over-block

No block/allow surface — over-block not applicable. The new test fails builds whose Home text contains a raw hex id of 24+ chars or a `m_` id; a legitimately rendered long hex string (none exists on Home today) would fail it and would need the test's list adjusted deliberately.

## 2. Under-block

The text guard covers Home builders only, not the other console pages or the legacy dashboard, and it matches known patterns, not every possible piece of jargon. Session rows still show raw session names such as "topic-131280" (separate issue, queued to feedback — see Conclusion).

## 3. Level-of-abstraction fit

Right layer: the contradiction came from two view-model functions answering one question from different sources; the fix makes one model the source and the headline a pure function of it. Machine naming is resolved in the view-model from the pool the page already fetches; no server change needed.

## 4. Signal vs authority compliance

No authority added or changed. The test is a build-time check on display text, not a runtime gate.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point added; deterministic display formatting only.

## 5. Interactions

The "What I've promised" card still lists the same promise, so a waiting promise appears in both cards; the headline counts it once (combined card only). `headline()` keeps the old sum when given an uncombined needs card, so other callers/tests are unaffected. Pooled cards now wait for `/pool` (fast, already fetched) before painting, to have machine names; a failed `/pool` read yields an empty name map, so unreachable machines are described rather than named — never blank.

## 6. External surfaces

Operator-visible wording on console Home changes. No API, route, config or other-agent surface changes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes — the top card answers "what needs you" with the waiting promise as its first row, matching the headline.
2. **Zero raw internals as primary content?** Yes for this card and the lines changed: machine ids removed, "routine notices kept in the log" → "N automatic notices need nothing from you", "N need you" → "N waiting on you"; enforced by the new test. Session names like "topic-131280" in "What I'm doing" are a remaining internal label, queued separately.
3. **Destructive actions de-emphasized?** No destructive actions on Home — n/a with reason: read-only page.
4. **Plain language + phone width?** Verified by rendering the patched page in Chromium at 390px and 1280px with a live three-machine data snapshot: headline "One thing needs you.", card "1 thing", promise row visible, no horizontal scroll.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read: the card reads the pooled attention view and the mesh commitments view as before; this change only merges them in the browser. Machine names come from `/pool`, which lists every registered machine.

## 8. Rollback cost

Revert the PR; no data, config or migration involved.

## Conclusion

Ship. Found along the way, triaged: (a) session rows show raw names like "topic-131280" — not blocking this fix, minor → feedback queue; (b) a machine registered on the Studio with no name and not in the pool seen from this machine (m_a804…) — the console now describes it honestly; whether that registry row is stale is a separate check → feedback queue.

## Second-pass review (if required)

Not required: display-only, no gate/sentinel/session lifecycle.
