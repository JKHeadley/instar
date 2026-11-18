# Convergence Report — Local Verify: the age of an unverified main survives a restart

## Cross-model review: codex-cli:gpt-6-astra

A real outside (GPT-tier) review ran through the agent's codex CLI in all three rounds. A second, clean-door Claude review (claude-opus-5-5) also ran in all three; it is not a cross-family opinion and says so itself.

## ELI10 Overview

After changes are merged, the test line also tests the main branch as a whole, to catch the case where two changes that each passed alone break something together. To keep waiting changes moving, the line lets them go ahead of that main test, but only for 90 minutes: once the oldest untested merge is 90 minutes old, the main test goes first.

That 90-minute clock was kept only in memory. Every time the coordinating machine restarted, the clock started again from zero. On 18 November the machine was restarted twelve times for installs and re-ordering, never more than 79 minutes apart, so the clock never reached 90 and the main test did not run for almost twelve hours, with about 38 merges untested as a whole. The alarm that should have warned about it was reset by the same restarts. Nothing was broken, as the test showed when it finally ran, but nothing would have told us if it had been.

The fix stores the clock value in the small file that already stores which main commit was last tested green, so a restart no longer loses it. If the value is missing or cannot be trusted, the line does not guess: it treats the age as unknown and lets the main test go first. And so that an unknown age cannot hide forever, the time at which it became unknown is stored too, and the existing three-hour warning counts from there.

## Original vs Converged

The first draft stored the clock value and, when it was missing, fell back to the time of the last green test. A reviewer pointed out that this measures a different event: after a quiet weekend, one fresh merge would look days old and raise a false alarm.

The second version tried to avoid storing anything by working the age out from the git history at start-up. Review showed why that was worse: the read ran inside the server and could block it, it sometimes needed a network fetch, a late answer could overwrite a newer state, and a restart after a release commit produced a false alarm. Each of those needed more machinery.

The converged version is the simple one with the flaw removed: store the value with the green marker in one atomic write; a missing or unusable value means unknown, and unknown means the main test goes first; the moment it became unknown is stored as a lower bound for the three-hour warning. No git read, no network, no new file, no switch.

## Iteration Summary

| Iteration | Design in the text | Reviewers who flagged design | Design findings | Left behind | Spec changes |
|---|---|---|---|---|---|
| 1 | Age derived from git at start-up; failure means unknown, unknown means due | scalability and integration (1), decision-completeness and lessons (1), codex (1), clean-door Opus (1) | 4 | 10 | Cut: store the value in main-health.json; missing means unknown means due |
| 2 | Stored value; unknown is due | clean-door Opus (2) | 2 | 9 | Second stored field `unknownSince` as a lower bound for the 3-hour signal; restore on both load paths |
| 3 (cap) | As above with `unknownSince` | none | 0 | 7 | Precision edits only |

Standards-Conformance Gate: ran before round 1 on three successive drafts (3, 3 and 5 flags, then 4 on the text the reviewers saw), round 2 (1 flag) and round 3 (1 flag). The flags that changed the design: the fallback measured the wrong event; a 200-commit cap would cut the datum the age needs; a commit subject is not proof of content; a failed derivation must not look like a young age. The one flag left in rounds 2 and 3 is the inherited 90-minute threshold, which this change does not touch.

## Proportion

Tier 1 (small and reversible: two optional fields in one existing state file, about three source files, spec about 2,000 words). 3 rounds used of a cap of 3. The first round was spent on a design that was then cut; rounds 2 and 3 were on the design that ships.

## Experience fit

Source: the operator's standing concern that things are checked without anyone having to remember, and the 18 November incident (last green main verify 10:44:59Z; next one started 22:14:09Z). Contrasting cases weighed: frequent restarts with unverified merges (main must still come due) against a restart with nothing unverified (nothing changes) and a first boot on the new build (one main verify goes first). Evidence limits: the twelve boots are read from the coordinator's own audit log; two further lease acquisitions were in-process. Disposition from the lessons-aware reviewer, final round: yes, main gets checked without anyone remembering, across any number of restarts, and missing state errs toward checking. The honest cost is stated in the spec: one pull request run waits behind a main verify per unknown episode.

## Left behind

- The standards gate's repeated flag on the inherited 90-minute and 3-hour thresholds: out of scope here; they are specified in the parent spec and changing them is its own decision.
- Frequent coordinator lease changes: a separate matter, worked in PR 3460 by the scaling session.
- Round-3 precision edits (per-episode cost wording, validation of `unknownSince`, single encoding of unknown, the lower bound on the foreign branch, the corrected stale-value example, the wall-clock row, the `atLeast` marker, the write-failure trace) were applied without a further review round.
- If the watermark write keeps failing and restarts come less than three hours apart, the warning is pushed back each time; main stays due throughout and the existing write-failure audit line is the trace.
- A green verify of an older head while the age is unknown restarts the age at now, young by at most one verify's duration.
- An older build drops both fields at its next write; after re-upgrade the age is unknown and due once.
- The graduation check reads audit lines by hand; no automated reader is built.

## Full Findings Catalog

Round 1 (git-derived design).
- Scalability and integration, DESIGN: the git read is synchronous in the server process, includes a network fetch, and triggers on every merge onto a green main, not only at boot. Resolved by removing the git read.
- Decision-completeness and lessons, DESIGN: the transitions around unknown were incomplete (retry of a failed read, the release-collapse path, a green verify of an older head). Resolved by the cut.
- Codex, DESIGN: an asynchronous result could arrive after the head advanced and clear priority from unverified work. Resolved by the cut.
- Clean-door Opus, DESIGN: a restart after a collapsed release commit made that commit the oldest uncovered one and raised a false alarm. Resolved by the cut.
- Security and adversarial: converged; precision only (pending read counts as due; back-dated commits; a conflict between two statements; the loop bound).
- Precision (10): who waits; ladder id shaped like a config key; incident table incomplete; decision row basis; others. Folded in.

Round 2 (stored value; unknown is due).
- Clean-door Opus, DESIGN: unknown passed nothing to the three-hour signal, so repeated erroring main verifies or fast restarts could keep it silent forever. Resolved: `unknownSince` stored and used as a lower bound.
- Clean-door Opus, DESIGN: the evidence counted lease acquisitions while the fix restored at process boot. Resolved: twelve of fourteen were boots (audit log), two were in-process re-acquisitions; restore is specified for both paths of `load`.
- All three internal pairs: converged. Codex: no design finding.
- Precision (9): three-boot test; load on re-acquisition; write-fails row; registry note; graduation wording; stale-value wording; why not git, softened. Folded in.

Round 3 (cap).
- All three internal pairs, codex and clean-door Opus: no design finding.
- Precision (7): listed under Left behind or folded in.

## Convergence verdict

Converged at round 3 of 3: the final round found nothing that changes what gets built; seven items are left behind, none a design finding. Open questions: none. The spec is ready for review and approval by the Chief of Staff; nothing is built before that approval.
