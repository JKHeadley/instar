# Side-Effects Review — Merge hand-off: look again when GitHub was not ready

**Version / slug:** `merge-handoff-recheck`
**Date:** `2026-11-19`
**Author:** `echo (scaling session, topic 145097); built by a Codex builder to the approved spec, reviewed by an independent reviewer`
**Second-pass reviewer:** `independent reviewer subagent (not the builder)`

## Summary of the change

When a change passes its verify, the verifier asks the merge watcher to merge exactly that change at once (the hand-off), and holds its queue until the watcher answers. One hand-off in five ended without a merge (32 of 154 between 2026-11-16 and 2026-11-19). The largest group, 15 cases, answered "not mergeable", and all 15 merged later at the same head. The likely cause is that GitHub had not yet said whether the change could be merged (`UNKNOWN`), which the watcher treats as not mergeable.

This change (spec `docs/specs/merge-handoff-recheck.md`, approved by the Chief of Staff on 2026-11-19 07:52 PT):

- In exactly that case, inside the same hand-off pass, the watcher looks at the direct read it already makes for the change and, while GitHub still says `UNKNOWN`, reads that one change again after 5, 10 and 15 seconds. When GitHub says `MERGEABLE` at the handed-over head, the change is judged again and continues through the existing hand-off path to the merge attempt.
- During the waits the pass keeps the watcher's single in-flight marker, so no other merge round runs underneath it.
- Off by default: `monitoring.greenPrAutoMerge.handoffRecheck`, read live at each hand-off.
- With the switch on or off, the hand-off's answer now says whether GitHub's value was unknown or conflicting, and the first value is recorded, so that a baseline with the switch off can confirm or disprove the cause.
- Three counts under `mergeLine` in `GET /local-verify`; an audit row per delayed read; an awareness entry; a ladder entry; an upgrade note.

Files: `src/monitoring/GreenPrAutoMerger.ts`, `src/monitoring/greenPrAutomergeWiring.ts`, `src/localVerify/LocalVerifyService.ts`, `src/localVerify/localVerifyWiring.ts`, `src/commands/server.ts`, `src/core/types.ts`, `src/data/feature-ladders.json`, `src/data/awareness/merge-handoff-recheck.md`, tests in all three tiers.

## Decision-point inventory

- **Whether a change is merged:** unchanged. The same eligibility rule and the same checks decide; the only new input is a fresher value of GitHub's own `mergeable` field for the same change at the same head. There is one merge path.
- **Whether the hand-off reads the change again (new):** one named condition, fixed waits, a fixed count, one switch.

## 1. Over-block

- **The queue is held up to a minute longer** on a hand-off that still misses (30 seconds of waits plus the reads). Only on hand-offs that would have missed anyway; about 3 seconds averaged over all hand-offs at the measured rate.
- **One regular merge round can be skipped** while the pass holds the marker; it runs at its next time, 10 minutes later.
- **A second green change that finishes during the longer hold gets no hand-off of its own** and waits for the regular round, as it does today when a hold is open. Counted.
- Nothing here refuses a merge that would have happened before.

## 2. Under-block

- **Could a change merge that would not have merged before?** Only a change that GitHub itself now calls mergeable, at the verified head, and that passes every check a hand-off passes today: the lease and the merge-allowed switch (read again after the waits), holds (including one put on during the waits), the earlier refusal for want of an independent review, the code-owner rule, the read immediately before acting, and safe-merge with its own checks. The same change would have been merged by the regular round up to 10 minutes later.
- **A hold released too easily.** The hold-release bookkeeping needs two passes; the re-check reuses the result worked out earlier in the same pass and never computes it a second time. Tested.
- **The cause is not the one assumed.** Then the switch changes nothing; the recorded first values show it within days and the change is removed.

## 3. Level-of-abstraction fit

The re-read lives where the decision is made: in the watcher's hand-off pass, at the point where the target is found not eligible. An earlier draft repeated the whole pass from the verifier's side; review showed that a whole pass does far more than look at one change. The verifier only passes the hand-off's start time down and records what comes back.

## 4. Signal vs authority compliance

- GitHub's `mergeable` value is the signal. The watcher's existing checks and safe-merge remain the authority. The re-read gives the authority a fresher signal; it adds no authority of its own.
- The counts and audit rows are signals for the 7-day review and decide nothing.

## 4b. Judgment-point check (Judgment Within Floors standard)

- Waits of 5, 10 and 15 seconds, three reads, a 10-second limit per read: starting values, revised from the recorded rows at the review. A wrong value costs at most a minute of hold and merges nothing.
- Whether the switch is turned on after the baseline: the operating session's decision on the reported counts, with a default (on when at least half of the refusals began with `UNKNOWN`).

## 5. Interactions

- **The watcher's single in-flight marker.** Taken before the first wait, used by the merge attempt, released after the pass's one save on every ending. A regular or manual round that arrives meanwhile is skipped as busy, as it is during a merge attempt today.
- **The verifier's hold and its 30-minute limit.** Unchanged. A merge reported after the hold timed out is not counted as recovered.
- **A planned restart** waits for the hold as today.
- **The breaker for skipped rounds.** A round skipped during a re-check does not move it (the owning pass's save replaces that mark); stated in the spec.
- **Other changes in the list.** Not looked at again; their hold bookkeeping is not advanced.

## 6. External surfaces

- Up to three more reads of one pull request from GitHub per affected hand-off (about 15 a day at the measured rate). No new list call.
- `GET /local-verify`, under `mergeLine`: the switch and three counts.
- The answer strings `handoff-not-eligible:not-mergeable-unknown` and `-conflicting` replace `handoff-not-eligible:not-mergeable` in logs; nothing parses the old string.
- One new config key, off when absent. No migration.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new notice. The operating session reads three counts and, after the baseline, flips one switch.

## 7. Multi-machine posture (Cross-Machine Coherence)

The hand-off and the merge watcher run only on the machine that holds the coordinator lease; a peer never merges. The switch is read on that machine (machine-local by the approved Local Verify capacity spec: the merge line is the coordinator's). The lease is checked at the start of the pass and again after the waits.

## 8. Rollback cost

The switch is off by default; turning it off restores today's flow at once, with the two new answer strings. Reverting the change removes one branch of the hand-off pass and three counts; no stored data needs converting.

## Conclusion

A small change at the point of decision, behind a switch, preceded by a baseline that can disprove its own premise. It adds no authority to merge; it lets the existing authority ask GitHub the same question again for up to half a minute before giving up.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context; not the builder, which was a Codex builder), run by the scaling session on 2026-11-19 at about 08:20 and 08:35 PST against the uncommitted change
**Independent read of the artifact: concur**

Two rounds, both concur; no must-fix in either.

- **Round 1: concur, five should-fix, all taken.** The reviewer traced a hand-off whose target was `UNKNOWN` and became `MERGEABLE` on a re-read, from the re-read to the merge attempt, against `main`: there is one merge call site; the lease and the merge-allowed switch are read a second time after the waits; the breaker, the floor and the warm-up rule are read at the start of the pass; the eligibility rule runs on the fresh row; the hold, the hold-release result (worked out once and reused), the earlier refusal for want of an independent review and the code-owner rule run from the same code as for any eligible change (moved, not copied); then dry-run, the read immediately before acting with its head pin, and safe-merge. Nothing is skipped or weakened. The five points: the lease's tenure is now compared as well as its ownership after the waits (a lease lost and regained ends the hand-off with no attempt); `main`'s saves at the start of a pass are kept for every pass; the count of hand-offs that met `UNKNOWN` works with the switch off, which the baseline needs; the hold test now fails if the hold check on the fresh read is removed; a test covers the merge attempt throwing while the pass owns the marker.
- **Round 2: concur.** All five closed, each with a test. The reviewer found the bookkeeping the builder had added for one of them (deferring the save a pass makes at its start when the floor setting has just changed) to be more machinery than needed and to leave a rare window `main` does not have. It was deleted: `main`'s block runs unchanged for every pass, so that save always happens before the marker can be taken, and from the marker to its release there is one save and one owner. One spec sentence was made exact to say this.

Confirmed in both rounds: with the switch off, the sequence of saves and loads is `main`'s, and the only differences are the two answer strings, the recorded first value and the hand-off's start time on its rows; the marker cannot stay set (it is released on every ending, including when a read, a check or the merge attempt throws).

Tests run on the authoring machine (by the builder and by the scaling session, at most five files per command), all passing: the unit files `green-pr-local-floor`, `green-pr-automerge-wiring`, `green-pr-automerger`, `green-pr-layer2`, `green-pr-logic`, `green-pr-red-watchdog`, `green-pr-passing-record`, `green-pr-open-pr-list`, `LocalVerifyService`, `mergeLineWiring`, `feature-ladders-coverage`, `awareness-entry-registry`; the integration file `merge-handoff-recheck` and the lifecycle file `merge-handoff-recheck-lifecycle` in the builder's runs. Type check clean. Not run: the rest of the suite (run by Local Verify).

**The merge with `main` (first-part report, #3504), read by a second reviewer (Codex, read-only) on 2026-11-19 at about 09:10 PST: concur.** One textual conflict, in `src/data/feature-ladders.json`, where both sides changed the end of the list; both entries are kept, each once. Git combined `LocalVerifyService.ts` and `localVerifyWiring.ts` by itself; the reviewer confirmed that every piece of this change is intact there (the start time passed to the watcher, the result and late-answer rows, the three counts, the status block, the live switch), that every piece of `main`'s is too, that neither side refers to anything the other removed, and that both status blocks are present with no key overwritten. One line changed after the merge, a comment only: the read that ends a re-check when it fails now carries the marker the silent-fallback guard test requires, saying that the failure ends the re-check with today's answer and is written in the audit row (the guard test counted one unmarked catch over its tracked number on the merged tree). After the merge: type check clean; the unit files `no-silent-fallbacks`, `feature-ladders-coverage`, `green-pr-local-floor`, `LocalVerifyService`, `mergeLineWiring` and `firstPartService` pass.

## Evidence pointers

- Spec and approval: `docs/specs/merge-handoff-recheck.md` (frontmatter `approved-by`); convergence report `docs/specs/reports/merge-handoff-recheck-convergence.md`.
- Measurement behind the problem statement: the scaling project's state file `state/scaling/handoff-misses-1116-1119.json` on the authoring agent (not in the repository).
- Tests: `tests/unit/green-pr-local-floor.test.ts`, `tests/unit/green-pr-automerge-wiring.test.ts`, `tests/unit/localVerify/LocalVerifyService.test.ts`, `tests/unit/localVerify/mergeLineWiring.test.ts`, `tests/integration/merge-handoff-recheck.test.ts`, `tests/e2e/merge-handoff-recheck-lifecycle.test.ts`.

## Class-Closure Declaration (display-only mirror)

Not a defect fix: the hand-off behaved as specified ("a hand-off never retries"). The class is "a single attempt at a moment when an outside service has not finished computing"; the same shape exists for a status still pending and for a change missing from the list, which are out of scope here and listed in the scaling project's notes with their counts.
