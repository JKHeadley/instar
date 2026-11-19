# Convergence Report — Local Verify: hold a change and move a change to the front, without a restart

**Spec:** [docs/specs/local-verify-queue-controls.md](../local-verify-queue-controls.md)
**Slug:** `local-verify-queue-controls`
**Converged at:** 2026-11-19 (round cap, Tier 2: 6 rounds)
**Iterations:** 6
**Final-round design findings:** 3, all from the outside-model reviewer. Each was applied in one edit at the cap and not re-reviewed. None concerns safety, security or data loss (see Convergence Verdict).

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT-tier pass ran through the codex CLI in all six rounds. The six internal lenses ran as one combined Claude subagent on the authoring session's model, Claude Fable 5.2, in rounds 1 and 2, and returned "converged, 0 design findings" in round 2. Rounds 3 to 6 were outside-model rounds on small edits. The Standards-Conformance Gate ran in rounds 1, 2 and 4; in round 3 the server was restarting and the gate did not answer; it was not run in rounds 5 and 6.

---

## ELI10 Overview

Every change to Instar waits in a queue to be tested on our two computers before it can be merged. Sometimes whoever runs that queue needs one change tested first, because others are blocked behind it, or needs a change kept out for now. Today the only way is to edit the queue's file by hand and restart the server, and a restart cancels the tests that are running on both machines. On 18 November 2026 the server was restarted 24 times, about 9 of them only to change the order, and 9 test runs were cancelled part-way.

This design gives the operator two controls that work at once, with no restart. **Hold** takes a change out of the queue until it is released; its place goes to the next change waiting, and when released it comes back with what it had. **Front** makes a change the next one to be tested, and works even when the queue is full and the change is not in it, which was exactly the case that forced restarts that evening. Neither control touches a test that is already running.

The benefit in merged changes is small, about half to one a day, because the tests thrown away by reorder restarts are a modest share of the day. The main gain is time: an urgent fix reaches the front in seconds. The controls are switched off until the operator of a line turns them on.

## Original vs Converged

- **"Remove" was dropped.**
  - Originally: three controls, including removing a change from the queue.
  - After review: two. A hold now takes the change out of the queue and frees its place, which does the same job. Why: the service's own re-requests would have undone a removal, and a removal was invisible afterwards.
- **Front works on a full queue.**
  - Originally: front refused a change that was not queued, and a full queue refuses new requests.
  - After review: front admits the change, within a small shared budget of places over the limit. Why: the operator pointed out that this was its most common case; without it the design would not have ended the restarts.
- **Choices are read at the moment of decision, not stored on queue entries.**
  - Why: the code rebuilds entries and overwrites their priority on every re-request, restart and new push, so anything stored there is lost.
- **The regular check of the shared code is protected.**
  - Originally: a fronted change went ahead of it without limit.
  - After review: at most one fronted change goes ahead of a due check, the allowance is recorded durably, and the worst case (which can raise an existing alarm) is stated.
- **Release puts back exactly what the hold took out,** including a pending re-test, and never starts a test by itself.
- **Every pair of writes has a stated order and a recovery at boot,** and the final choice, the allowance and the start are one guarded step that a hold request also goes through.
- **A forgotten hold gets one reminder, not a daily one,** and holds that come due together are reported together.
- **The service records why it restarted,** so the result can be counted instead of remembered.

## Experience fit

- **The goal, from the user of these controls.** The throughput session operates the line. Its message of 2026-11-18 22:55 PST: "the queue has no reorder and no remove, and do-not-merge does not stop a queued entry. Those three missing controls (reorder, remove, hold) are why I restart." Its read of the draft (file `throughput-read.md` in the review folder) ranked its needs: front on a full queue first, then hold, then front, then remove.
- **The ordinary journey.** One request to hold, with a reason; one to release. One request to front. The queue view shows held and fronted changes. No restart.
- **Contrasting cases checked.** A hold on a change that is already running (left alone; applies if it comes back). A hold meant to stop merging too (one request with `blockMerge`). Fronting again and again (allowed, audited, and stated plainly as an operator override with no fairness guarantee for ordinary changes).
- **Evidence and limits.** Restart counts and interrupted runs are measured from the audit log; the reasons for restarts are the operator's approximate account, quoted. The benefit in merges is a projection with its conditions stated.
- **Disposition.** All seven of the operator's points are in the text. Remove was dropped with its agreement sought; it has not objected.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | internal (combined), codex, the operator | 8 internal, 5 codex, 7 operator points | 18 | Whole document rewritten: remove dropped, hold takes the entry out, front admits over the cap |
| 2 | codex (internal: converged, 0 design) | 4 | 7 | What the controls remember, hold, front, limits |
| 3 | codex | 5 | 0 | Unreadable file, release, main allowance, front limit |
| 4 | codex | 4 | 1 | Release, result definition, switch, benefit |
| 5 | codex | 4 | 1 | Front admission, release, unhealthy-main turns, guarded pick |
| 6 | codex | 3 | 1 | Hold under the same guard, release rule, the alarm consequence |

Standards-Conformance Gate: ran in round 1 (12 flags), round 2 (14) and round 4 (11); unavailable in round 3 (server starting); not run in rounds 5 and 6. Its repeated flags are fixed starting values (answered in the Fixed limits table as starting values behind an off switch) and the multi-machine posture of the operator file (answered in the posture section, with the limit stated).

## Full Findings Catalog

The full text of every finding is in the agent home under `.instar/state/scaling/converge-queue/` (`r1-review.md`, `r2-review.md`, `r1..r6-codex.json`, `throughput-read.md`, `r1/r2/r4-gate.json`). Design findings by round:

- **Round 1.** The service's own callers would clear a removal; a held entry still counted as waiting work; the front mark would be overwritten on re-request, restore and a new push; "used up at start" lost the mark on re-runs; front could starve the main verify; removal was invisible; the operator file never forgot closed changes and the reminder repeated forever; front could not reach a full queue (internal and the operator). Hold or removal racing the base refresh; two files written with no order; the stalled alarm; the 201st record (codex). All resolved by the rewrite.
- **Round 2.** A front arriving during another change's refresh; one overflow budget across release and front; the mark ending on a derived result; release durability (codex). Resolved.
- **Round 3.** Recovery from a rotated audit log could not be trusted (replaced by a previous good copy); release completing on the waiting list; the main allowance surviving a restart; fairness for ordinary changes (accepted and stated); release of a never-requested or finished change (codex). Resolved.
- **Round 4.** Hold, front, release of an unrequested change; "result" by the index key; allowance spent before dispatch; switch-off stranding held changes (codex). Resolved.
- **Round 5.** Front admission across a crash; a held pending re-test; turns while the shared code is unhealthy; one guarded pick (codex). Resolved.
- **Round 6 (cap).** A hold arriving during the allowance write; release deciding from the saved entry, not from a result; the allowance's worst case raising the 3-hour alarm (codex). All three applied; the third is accepted and stated. Not re-reviewed.

## Proportion

Tier 2 (new operator authority to stop a verify from starting); the spec is about 190 lines and the build is estimated at a few hundred lines of code. Six rounds used of a cap of six. That is more rounds than the size suggests: after round 2 every round was one reviewer walking further crash and race sequences in a small state machine, each a one-sentence rule.

## Left behind

- Ordinary changes have no progress guarantee against repeated fronting: accepted as an operator override, audited, reported at the 7-day review.
- A hold still unresolved after its one reminder is surfaced only in the queue view and the 7-day review.
- `by` is a label, not a verified identity; the routes trust the server credential as the existing routes do.
- A lease move to another machine loses holds; stated as a limit.
- No phone or dashboard surface in this change.
- The fixed starting values the gate flags (200 records, 3 fronted, 5 overflow places, 24 hours).
- Round 6's three edits and rounds 3 to 5's edits were not seen by the internal reviewer; rounds 5 and 6 were not seen by the gate.

## Convergence Verdict

Converged at the round cap (round 6). The internal reviewer found nothing that changes what gets built in round 2. The outside-model reviewer raised three design-class points in the final round; none is about safety, security or data loss (two are orderings between a hold and a start, one is a stated alarm consequence), and all three are in the text. `## Open questions` is empty.

The spec is ready for the Chief of Staff's review. What needs approval by name: a new operator authority to keep a queued change from being tested, and to put a change first, on the machine that owns the queue, behind the server's existing credential and an off-by-default switch.
