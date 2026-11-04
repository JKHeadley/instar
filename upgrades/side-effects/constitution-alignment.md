# Side-Effects Review — constitution pairing check and merge-tool wiring

**Version / slug:** `constitution-alignment`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, appended below`

## Summary of the change

Step 1 of `docs/specs/constitution-alignment.md`. Adds `scripts/check-constitution-pairing.mjs`: every PR touching a constitution book must name its counterpart in the other repository, or say why it has none. `scripts/safe-merge.mjs` refuses a registry PR that doesn't. `GreenPrAutoMerger` treats that refusal as waiting on a body edit. Also adds the map of existing differences and corrects `docs/STANDARDS-DIRECTION-GUARD.md`. No constitution text changes here. Tier 2; 5 spec review rounds of a cap of 6; about 6 files and 450 lines, most of it tests.

## Decision-point inventory

- safe-merge refusal on a missing or unreal declaration: **add**, invariant. Existence only.
- `none:` honesty and same-obligation: judgment-candidate, held by the independent review of each change. No code here decides it.

## 1. Over-block

A PR touching the registry with no line is refused until one line is added. That includes a typo fix; the requirement says all updates. Clearing it takes one body edit and dismisses no approval. A failed read of a named counterpart refuses a registry PR with state `unknown`. A failed read of the PR's own file list refuses *any* PR on this repository with state `unread`, because whether it touches a book isn't known; its message says to retry and the watcher re-reads in 15 minutes. safe-merge already stops on any failed `gh` read a moment earlier or later, so this adds no new class of outage, only one more read that can hit it.

## 2. Under-block

- A dishonest `none:`, or a pair that changes something else in the other book. Not visible to a script. The independent review and the operator's review hold it.
- A merge not going through safe-merge, and every merge in instar-2. Caught by the daily run, within a day.
- A PR body edited after merge can mislead the daily read. Accepted.

## 3. Level-of-abstraction fit

The merge funnel is the right layer in instar: the base-branch refusal lives at the same point. A GitHub required status check would be stronger but needs the operator's admin action on two repositories, and the daily run backs it up.

## 4. Signal vs authority

Compliant, per `docs/signal-vs-authority.md`: the blocking authority covers a closed existence question, in the shape of the Maturation Path plan gate, over inputs no model is needed to read. All judgment of meaning stays with a mind. The refusal is cheap to clear and says exactly how.

## 5. Interactions

- Sits immediately after `nonMainBaseRefusal`, before every floor. Base refusal still wins for a stacked PR.
- `GreenPrAutoMerger`: new branch, no ladder attempt, re-read every 15 minutes, since the fix moves no head. Without it, the default ladder would give up. A body edit therefore takes up to 15 minutes to be seen. An approved registry PR with no line waits on audit only, with no attention item: the author is me, and the reader of that item would be the operator, who can't fix it.
- Adds two `gh` reads per safe-merge run on `JKHeadley/instar`. A registry PR adds a read of the counterpart. Negligible.
- `scripts/safe-merge.mjs` now imports a sibling file, the same way it imports its existing siblings.

## 6. External surfaces

Instar's own PR process only. `scripts/` ships to the fleet, where this is inert: any repository but the two named no-ops. No user-facing change, no message, no route.

## 7. Multi-machine posture

Unified. No local state: GitHub is the only record. The same script behaves identically on every machine.

## 8. Rollback

Revert. Removes the refusal and the watcher branch. No data migration. The daily job, added at landing on Echo, is disabled in one edit.

## Evidence

- Unit: `tests/unit/check-constitution-pairing.test.ts`. Integration: `tests/integration/safe-merge-constitution-counterpart.test.ts` runs the real script with a fake `gh`, including the refusal path, the unreadable-counterpart path, and a PR touching no book.
- Live positive control, against real history since #2323: `paired=0 declared-none=0 waiting=0 overdue=0 drift=5 no-pr=0`, naming #2682, #2380, #2194, #2323 and instar-2 #182. All five lack a line, so this proves the no-line class only; fixtures cover the rest. A real TLS failure on an earlier run printed `unknown` and did not read as clean.

## Second-pass review

**Reviewer:** independent general-purpose subagent, on claude-opus-5-5

Independent subagent, 2026-11-03. Concern raised: a failed first read refused every PR on the repository, labelled as a constitution change. Verified live with a 404. Resolved: a separate `unread` state with its own message, this artifact and the spec corrected, tests added. It also found that a line naming a nonexistent PR made the whole daily run `unknown`; now one row of drift, tested. Everything else it checked held: standalone run from a temp directory, real page shapes, state mapping, `nextEligibleAt`. Recorded after fixing; the concern is resolved by these changes rather than concurred with as first written.

**Second-pass re-check of the fix:** Concur with the review.
