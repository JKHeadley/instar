# Side-Effects Review — grading-job idle effect proof

**Version / slug:** `job-grade-pass-idle-proof`  
**Date:** 2026-10-28  
**Author:** Echo  
**Second-pass reviewer:** grade_receipt_review found cursor-only and missing-recorder false positives. Both were fixed. Final recheck concurred with the narrow ledger-idle claim; both rollout gates remain off.

## Summary

The grade-pass route writes an optional proof hash into the existing
job-supervision journal only after strict pre/post quality-ledger reads and a
real pass run. The worker can turn a Jev routine verdict into a correct grade
only when that separate proof exists. No model call or rollout gate changes.

## Decision-point inventory

- The route decides whether the grade-pass workset is provably empty. It
  requires a scheduled run token, a live recorder wired to the same quality
  ledger, zero rows for all six
  grading points before and after, unchanged cursor boundaries, and zero grades.
- A read error, any history, a nonzero pass, manual call, or dry-run denies
  the proof. The ordinary count receipt can still be recorded.
- The worker grades only a settled, evidence-sufficient routine verdict for
  `llm-decision-grading` with the independent proof. Otherwise grade is
  unknown. It never closes an investigation on this proof.
- Jev and replacement provider admission remain off behind both code gates.

## Over-block

Any historical decision row at a grading point prevents this proof, even if
that row was graded already. This deliberately loses positive samples in
exchange for an auditable first rule. Future work may prove terminality per
row before widening the gradeable set.

## Under-block

The first version read only after each grading cursor. A late row behind a
cursor could have produced a false positive. The strict snapshot now counts
all rows at every point before and after the pass. Any row denies proof.
The second review found that a configured live seam could lack a live runtime
recorder; the route now denies proof unless recording is actually live and
wired to the same ledger the pass reads.
The full verifier also required the strict-read catches to be explicitly
classified: those failures deny proof and leave the outcome unknown while the
ordinary grade pass runs. The silent-fallback ratchet remains at 494.
The proof only establishes that this pass had no quality-ledger work. It
does not establish the correctness of nonempty grading rules or provider
judgments for other jobs. It also cannot certify upstream producer completeness
or unmatched hog-source records. Those outcomes stay unknown.

## Architecture and authority

The proof is computed inside one immediate SQLite writer transaction around
the pass, so another writer to the quality ledger cannot insert a decision
between the reads. The optional hash is persisted under the scheduled run's
server-validated receipt token. Jev sees the ordinary receipt, but never the
independent proof hash. The worker links the proof to the settled current
call; the quality view can then count that call's outcome. The hash is a
content-free evidence identifier, not an authorization token.

## Multi-machine and privacy

Each machine records its own proof in its own journal. The direct quality
view reports machine-tagged aggregate coverage and does not expose the
proof's raw pre/post snapshot or script output to peers. Missing machines
remain coverage gaps.

## Migration, rollback and tests

The store adds `idle_proof_hash` idempotently. Old receipts remain valid count
receipts without a proof. A rollback can ignore the extra column; it does
not make old data unsafe. Fresh and existing agent instructions mention the
narrow rule. Unit, authenticated route, and production boot tests cover the
decision boundary and live wiring. Full-suite and CI must pass before merge.

## Class-Closure Declaration

This closes one narrow gradeability case only. It does not close the broader
independent-outcome or Jev rollout requirements.
