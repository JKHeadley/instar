# Side-Effects Review — a main-red refusal no longer uses up a PR's merge attempts

**Version / slug:** `automerge-main-red-not-an-attempt`
**Date:** `2026-11-08`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose reviewer subagent (fresh context), 2026-11-08`

## Summary of the change

`applyOutcome` in `src/monitoring/greenPrLogic.ts` (the green-PR auto-merger's per-PR attempt ladder) now treats `refused:main-red` like the existing non-ladder outcomes: it records the outcome and retries after one base backoff, without advancing `attempts` and without feeding the breaker. `refused:main-red` is also added to the tick loop's `PASS_ON` set in `src/monitoring/GreenPrAutoMerger.ts`, so the oldest refused PR passes the turn to the next PR in the same tick. Before, three short red spells on main moved a verified PR to `gave-up`, which only a new head re-arms; #2879 sat green on one head for about two days this way (gave up 2026-11-07 01:30Z, merged by hand 11-09). Tier 1: two source files (+14 lines), two test files. Effort: 0 spec rounds, 3 commit attempts (two message corrections, one to add these artifacts through the gate).

## Decision-point inventory

- `applyOutcome` attempt ladder (greenPrLogic.ts) — modify — one more outcome classed as non-ladder.
- Tick loop `PASS_ON` (GreenPrAutoMerger.ts) — modify — a main-red refusal no longer ends the tick.
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
- **Races:** while main stays red, a refused PR is offered again every tick (the 600 s tick is the real limit; the 30 s base backoff has always passed by then). That costs one cheap safe-merge refusal per tick, before any merge call.
- **Head-of-line:** without the `PASS_ON` change, the oldest main-red PR would end every tick and block newer PRs, including one verified against the current main head (which safe-merge still admits during a red spell, often the PR fixing main). With it, the next PR is tried in the same tick, as for `deferred:checks-pending`.
- **Attention:** a PR waiting out a long red spell no longer raises the "could not be auto-merged" line. Main's own health is surfaced by Local Verify (`local-verify:main-red-hold`, the main-health status), which is the right place for it.

---

## 6. External surfaces

None for users. During a long red spell, each stale-base candidate costs one cheap safe-merge refusal per 600 s tick (it refuses before any merge call), so the cost scales with the number of open candidates.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the auto-merger runs on the serving-lease holder only, and its episode state is that machine's file.

---

## 8. Rollback cost

Revert the commit. Episode state needs no repair: affected episodes simply have fewer counted attempts.

## Second-pass review

**Reviewer:** independent general-purpose reviewer subagent, fresh context, given the diff, this artifact, docs/signal-vs-authority.md, greenPrLogic.ts, GreenPrAutoMerger.ts and safe-merge.mjs (2026-11-08 ~20:00 PST).

First pass: CONCERN. (1) Starvation: the 30 s base backoff is shorter than the 600 s tick, and `refused:main-red` was not in `PASS_ON`, so the oldest main-red PR would end every tick indefinitely and block newer PRs, including one verified against the current main head. (2) No busy loop: at most one safe-merge call per tick. (3) No authority loosened: `evaluateLocalPredicate` still refuses every record not verified against the current main head. (4) Tests covered the ladder only, not tick ordering. (5) This artifact misstated the retry rate and missed head-of-line blocking and the lost attention line.

Resolution: added `refused:main-red` to `PASS_ON`; added a merger-level test (older PR refused for main-red, newer PR merges in the same tick, no attention line); corrected Races and added Head-of-line and Attention above.

Re-review of the revised change: **Concur.** At most one real merge attempt per tick is kept; oldest-first was never strict (gave-up, backoff and checks-pending already pass the turn); a newer PR verified on the current main head merging first is what the main-red rule in docs/specs/local-verify-merge-authority.md §3 intends, and the older stale-base PR still cannot merge afterwards; the Local Verify hand-off tick and queue are unaffected; tests now cover both sides. One non-blocking note (per-candidate refusal cost) added under External surfaces.

## Conclusion

Safe to ship. No authority added or loosened; the refusal stays where it is.
