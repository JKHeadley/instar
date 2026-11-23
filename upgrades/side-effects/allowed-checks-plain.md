# Side-Effects Review — safety checks add up and read plainly

**Version / slug:** `allowed-checks-plain`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 3 files (~40 lines). `dashboard/console/allowed-model.js`: `humanKey` (now exported) lower-cases split words and keeps acronyms (PR, CI, LLM, API…); a new `guardTitle` drops a trailing dated incident parenthetical from the row title (the detail sheet keeps the full `criticalPath`); an unanswered machine is named from the `/pool` rows when its own failure entry has no nickname. `dashboard/console/allowed.js`: the "need a look" section holds only checks, and unanswered machines move to a separate "Machines I couldn't check" section, so the chip count (40) and the section count agree (was 42, because 2 machine rows were mixed in). Found by the 2026-11-20 live dashboard audit (topic 127504), verified on the live page through a proxy serving this branch. One build pass, first commit attempt.

## Decision-point inventory

No decision-point surface. `needsLook` and guard actions are unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Right layer: the page's own model and renderer.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority involved.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No decision point.

---

## 5. Interactions

The empty-state text now says "Every safety check that answered…" when some machines did not answer, so an empty need-a-look list never implies every machine was checked.

---

## 6. External surfaces

Dashboard wording and grouping only.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. Checks needing a look stay first, and the count matches the chip.
2. **Zero raw internals as primary content?** Yes. Code-name splits become words, and dated incident tags leave row titles.
3. **Destructive actions de-emphasized?** Not touched.
4. **Plain language + phone width?** Yes. Titles are shorter than before.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Pass-through: reads the existing pool-scope guard answer and `/pool`. Unanswered machines are now listed by name, separately.

**Status surfaces:** none.

---

## 8. Rollback cost

Revert the commit.

---

## Conclusion

A safe wording and grouping fix.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/console-allowed.test.ts`: humanKey words and acronyms, guardTitle, a pool-named unanswered machine, the section wiring.
- Live page through the branch proxy: "SAFETY CHECKS · NEED A LOOK 40" (was 42), with a separate "Machines I couldn't check 2".
- Console unit suite green.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
