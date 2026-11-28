<!-- bump: patch -->
# Correction Class Review Records Whether Its Proposals Were Right

## What Changed

The correction class review now writes to the shared feature evidence log. Each filled review records the verdicts it reached (never the correction's text), each failed model call records the failure, and each decision on one of its proposals records a grade: a proposal ratified or shipped counts as right, a rejected one as wrong, and a deferred or expired one counts as no grade. Grades come only from the operator's PIN-gated outcome choice; a completed work item marks the proposal shipped but is not graded, since the agent's own session usually completes it. Until now the review's quality bar on its maturation ladder had no writer, so its correctness could not be measured at all.

## What to Tell Your User

Nothing changes in what you see. When you accept or reject one of the improvements the correction review suggests, that choice is now also counted as a check on how good its suggestions are. Nothing else is asked of you.

## Summary of New Capabilities

`logs/feature-evidence.jsonl` gains `monitoring.correctionClassReview` rows: `fired` per filled review, `error` per failed attempt, and `outcome` rows (`right`/`wrong`, `gradesEventId` a digest per proposal, `gradedBy` `operator-outcome`) when the operator decides a proposed arm; after a reopen the latest decision stands. The ladder's graded-wrong bar reads them, counting only operator grades. The open `POST /maturation/evidence` route now refuses a `gradedBy` of `operator` or `operator-*`, so no caller holding the agent's token can write a grade in the operator's name; in-process code that checked the operator still records them. The shared ladder evidence reader now lets only a row inside a metric's scope take a deduplicated id's last-row slot, so an unrelated row sharing an id can no longer erase a grade, for every ladder metric that dedupes.

## Evidence

Unit tests cover the outcome-to-grade mapping on both sides, fired and error rows (with no correction text), a dry run writing nothing, ratified as right and rejected as wrong with their keys, no grade for a completed work item, expiry, an unknown review or an arm that was never a proposal, and the latest decision standing after a re-disposition. Integration tests drive the PIN-gated outcome route (a refused PIN writes nothing; ratified and rejected write right and wrong) and the open evidence route (an operator grader name is refused and writes nothing). A unit test reads the shipped graded-wrong metric through the real ladder evidence reader.
