# Side-Effects Review — plan approvals say what the OK is for

**Version / slug:** `plans-ok-names-round`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 7 files (~30 changed lines incl. tests). The "Waiting for your OK on round N" ask now appends the round's name (`: <name>`, word-cut at 80) when the round has one. Files: `dashboard/console/plans-model.js` (`roundNameSuffix`, used by `needsYouWords`), `dashboard/console/plans.js` (detail card title), `src/server/mobilePlansPeopleRoutes.ts` (`needsWords`, same words for the phone app, cleaned with the existing `cleanText`), and tests. Found by the 2026-11-20 live dashboard audit (topic 127504). One build pass; first commit attempt.

## Decision-point inventory

No decision-point surface. `projectNeedsOk` (when an OK is needed) is unchanged; only the words of the ask change.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. A round with no name keeps the old words.

---

## 3. Level-of-abstraction fit

Right layer: the two existing wording functions (console and server mirror) that already produce this sentence.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority added or changed.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No decision point.

---

## 5. Interactions

The Needs-you list de-duplicates by item id, not by the words, so a longer sentence does not change which rows show. The phone app reads `needs` as display text only.

---

## 6. External surfaces

The wording of an existing ask on the dashboard and in the phone app. There's no new route or field.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The ask now says what the OK is for, and the OK button is unchanged.
2. **Zero raw internals as primary content?** Yes. A plan-author round name is human text, cleaned and capped.
3. **Destructive actions de-emphasized?** Not touched.
4. **Plain language + phone width?** Yes. It's capped at about 80 characters of name, and the row wraps (checked at 390x844 in the audit).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Pass-through: the words are computed from the plan record each machine already reads; no state is added.

**Status surfaces:** none.

---

## 8. Rollback cost

Revert the commit. No data is touched.

---

## Conclusion

A safe wording clarification of an existing ask.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/console-plans.test.ts`: named round, unnamed round, long-name cut, blank name.
- `tests/unit/mobile-native-plans-people.test.ts`: the server's words match.
- `tests/e2e/console-home-lifecycle.test.ts`: Needs-you row "Waiting for your OK on round 1: Home".
- `tests/integration/mobile-native-plans-people.test.ts`: unnamed-round words unchanged.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
