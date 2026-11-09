# Side-Effects Review — a main-red refusal no longer uses up a PR's merge attempts

**Version / slug:** `automerge-main-red-not-an-attempt`
**Date:** `2026-11-08`
**Author:** `echo`
**Second-pass reviewer:** `not required (retry bookkeeping inside an existing authority; no new block/allow decision)`

## Summary of the change

`applyOutcome` in `src/monitoring/greenPrLogic.ts` (the green-PR auto-merger's per-PR attempt ladder) now treats `refused:main-red` like the existing non-ladder outcomes: it records the outcome and retries after one base backoff, without advancing `attempts` and without feeding the breaker. Before, three short red spells on main moved a verified PR to `gave-up`, which only a new head re-arms; #2879 sat green on one head for about two days this way (gave up 2026-11-07 01:30Z, merged by hand 11-09). Tier 1: one source file (+11 lines), one test file. Effort: 0 spec rounds, 3 commit attempts (two message corrections, one to add these artifacts through the gate).

## Decision-point inventory

- `applyOutcome` attempt ladder (greenPrLogic.ts) — modify — one more outcome classed as non-ladder.
- safe-merge's main-red refusal (scripts/safe-merge.mjs) — pass-through — unchanged; it still refuses while main is red.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change makes the merger retry more, never refuse more.

---

## 2. Under-block

No block/allow surface. The refusal itself is still made by safe-merge on every attempt, so a PR is never merged onto a red main. A PR that also has a real problem (red verify, body checks) still advances its ladder on those outcomes.

---

## 3. Level-of-abstraction fit

Right layer: the ladder already distinguishes ladder from non-ladder outcomes (`armed`, `error:auto-arm-unconfirmed`). Main health is a condition of main, owned by Local Verify's main-health signal, not of the PR; the ladder should not count it against the PR.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The merge authority (safe-merge's local floor) is unchanged. This only changes how often the merger asks it.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Main is red" is an enumerable outcome string returned by safe-merge.

---

## 5. Interactions

- **Shadowing:** none. The main-red hold in Local Verify keeps holding verifies; this only affects merge retries.
- **Double-fire:** none; one episode per PR.
- **Races:** while main stays red, a PR retries once per base backoff (cheap: safe-merge refuses before any merge call). It never reaches `gave-up` from main-red alone, so the "could not be auto-merged" attention line no longer fires for a red spell.

---

## 6. External surfaces

None for users. Slightly more safe-merge invocations during a long red spell, bounded by the base backoff.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the auto-merger runs on the serving-lease holder only, and its episode state is that machine's file.

---

## 8. Rollback cost

Revert the commit. Episode state needs no repair: affected episodes simply have fewer counted attempts.

## Conclusion

Safe to ship. No authority added or loosened; the refusal stays where it is.
