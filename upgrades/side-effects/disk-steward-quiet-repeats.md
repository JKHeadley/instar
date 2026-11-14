# Side-Effects Review — Disk Steward repeat posts back off at every level

**Version / slug:** `disk-steward-quiet-repeats`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1: 2 source files (`src/monitoring/diskSteward/levels.ts`, `src/monitoring/DiskSteward.ts`), 2 test files, one spec paragraph (§3.5). A revert undoes it; no stored data needs repair (`lastPostFree` is a new optional field on persisted cadence state, ignored by older builds).

Before: a warn post that was still true doubled its wait (capped at 7), but escalate and critical repeated at a fixed 6 h and 2 h. A machine stuck critical with nothing safe to clear (the Studio and the Laptop, 2026-11-11) posted the same text every 2 h, 48 posts in 4 days. Now every level backs off: each repeat with less than 1% of the disk reclaimable doubles the wait (multiplier capped at 12), each interval is capped (critical 24 h, escalate 24 h, warn 7 days), and a further drop of 2% of the disk since the last post resets the wait to the base interval at once (checked on every tick, not only when an alert is queued).

Effort: one commit attempt. This artifact, the release note and the decision record are added after the fact: the worktree was made with a plain `git worktree add`, so the commit hooks never ran and the merge line refused the PR on `decision-audit` and `release-fragment`. The PR is recommitted through the gate.

## Decision-point inventory

- `repeatInterval` / `nextRepeatBackoff` (`levels.ts`) — modify — when a still-true disk post repeats.
- Per-tick backoff reset in `DiskSteward.tick()` — add — a real drop ends the backoff.
- Level classification, thresholds, prune decisions, recovery posts — pass-through, unchanged.

---

## 1. Over-block

No block/allow surface on any input. The change only delays repeats of a post whose content has not changed. A machine that keeps losing space never waits: a 2% drop (about 18 GiB on a 926 GiB disk) restores the base interval on the next 15 min tick, and the first post of an episode, a rise in level and the first critical post are unchanged.

---

## 2. Under-block

A slow leak under 2% between posts gets only the backed-off repeats (at least one critical post a day). That is intended: the forecast line in each post carries the trend, and the floor posts still come through the significant path.

---

## 3. Level-of-abstraction fit

Right layer: cadence lives in `levels.ts` next to `repeatDue` and `gapAllows`, and the steward only records the free space at each post. No other component decides disk post cadence.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It changes when the steward repeats its own notice; it gates nothing else.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The repeat cadence is a bounded notification schedule (an enumerable domain: interval, cap, reset fraction), the same shape it had before at the warn level.

---

## 5. Interactions

- `NotificationSelectivityGate` critical episodes: each repeat still carries its own stage in `sourceContext`; fewer repeats only means fewer episodes.
- The prune cycle runs on each repeat; fewer repeats means fewer dry-run child runs, which is the intended saving.
- Recovery posts and level changes reset the cadence as before (`warnBackoff = 1` on episode end).

---

## 6. External surfaces

The Disk space topic receives far fewer identical posts (simulated: 7 instead of 48 over 4 days stuck critical). Post text is unchanged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, as before: each machine's steward keeps its own cadence state and the lease holder delivers posts. `lastPostFree` is per machine and travels in the same persisted state. **Status surfaces:** `GET /disk-steward` is unchanged in shape.

---

## 8. Rollback cost

Revert the commit. Persisted `lastPostFree` is ignored by the older code; `warnBackoff` values up to 12 are read by the older warn path as a larger multiplier and capped by its own 7-day limit, so no repair is needed.

## Conclusion

Safe to ship as Tier 1: notification cadence only, bounded at every level, and reset by real change.

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle or messaging block/allow decision is touched.

## Evidence pointers

- `tests/unit/diskSteward-levels.test.ts` (24 pass, 6 new: backoff, caps, reset).
- `tests/unit/diskSteward.test.ts` (11 pass; new: "critical with nothing to clear: repeats back off to once a day, and a 2% drop posts again at once", 7 posts in 4 days, a drop to 10 GiB posts within 9 ticks).
- `tests/integration/disk-steward-routes.test.ts`, `tests/unit/diskSteward-pruneCategories.test.ts` pass.

## Class-Closure Declaration (display-only mirror)

Self-triggered controller (a notify loop), class `unbounded-self-action`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the control loop is disk-post -> repeat; steady state with no change is one critical post per 24 h (multiplier capped at 12, interval capped at 24 h); the settling brake is the 2% drop reset, which only fires on new evidence, never on the post itself}`.
