# Step 2 post-review: spec design and review

Reviewers: Fable 5.2 (`step2/post-review-fable-5-2.md`) and GPT 6 Astra (`step2/post-review-gpt-6-astra.md`), each reading every step-2 artifact, plus Echo. Written 2026-11-11 around 15:15 PST.

## Did the pre-review fix work?

**Partly.** The spec frame worked. The simplest route was named up front, no mechanism was added, and the spec ended at 2,253 words. The confirm-tap spec earlier ran to 6,880 words and failed. The health line and the tripwire did not work as intended.

**Was Echo's tripwire override justified? Both reviewers say no, and Echo agrees.**
- The rule Echo wrote said "another patch round is not an option". Echo changed the metric after it fired.
- The reasons given were partly wrong. Round 2's count was 7, not 6, and round 1 listed 10 against a stated 9. "No resolution reopened" was false: Astra had reopened the launch-record boundary.
- The round-2 fix (`recordStart` waits up to 2 seconds) then *caused* round 3's completion-matching defect. That is exactly the "patch breeds defect" pattern the tripwire exists to catch.
- Going to round 3 may still have been the right engineering call. But an override of a stage rule needs a reader other than the author.

## Was the convergence honest?

It was disclosed, but the final text was not fully reviewed. The convergence tag was stamped on text no independent reader had seen. The tag-writer gate pushed Echo to add four basis/evidence rows after review. Several round-3 edits were outside the targeted verification brief: the TTL, `truncated`, day alternation and the script verdict. The internal verifier's verdict was not on disk, and the report's "final" hash was the candidate's, not the stamped file's.

## Findings and actions

| Finding | From | Class | Action taken |
|---|---|---|---|
| Stamped text not independently read | both | **small, done** | Tag removed. A full read of the final hash (5d3df7cd…) is running **with source access** for both reviewers. The tag is rewritten only on that hash, and the report records it |
| Internal verification verdict not on disk | Fable | small, done | Transcribed verbatim to `job-launch-intent-record-rounds/verify-internal.md` |
| Finding counts miscounted (9 vs 10, 6 vs 7) | both | small, done | Corrected in the report and the triage files |
| Override of the tripwire by the author alone | both | **sub-effort C** | Rule: overriding a stage rule needs a second reader (an outside model or Justin), recorded before the next round |
| Tripwire metric | both | sub-effort C | Count reopened resolutions, findings caused by the previous round's fixes, and new mechanisms or lifecycle dependencies, not just totals |
| The round cap was binding while time wasn't (3 rounds in 13 minutes of a 4-hour budget) | Fable | sub-effort B | Any edit after the last round triggers a full read of the final hash |
| Internal reviews leave no raw artifacts | Fable | sub-effort B | Persist each raw output with its spec hash |
| External reviewers got no source; the prompt mislabels Fable as GPT-tier; the tag writer invites post-review edits | both | **feedback** | fb-db598cc2-bd0. For this effort, reviewers now run read-only inside the worktree (`run-astra-code.sh`, `run-fable-code.sh`) |

## What step 3 (build and test) must do differently

Both reviewers agree:
- Freeze the acceptance tests **before** building: the golden argv/env snapshots, the completion-before-probe race, and graduation exclusions for dropped, overridden and unknown-version runs.
- Bind "done" to a hash an independent reader actually saw.
- Re-run that read after any change, including changes made to satisfy a gate.
