---
bump: patch
---

## What Changed

The scheduled decision-grading script can now receive a narrow independent
outcome grade. The server checks the quality ledger before and after the grade
pass in one SQLite writer transaction. It grants an idle proof only when all
six grading points have zero decision rows, the cursor boundaries stay unchanged, and
the pass reports no grades. The proof is stored separately from the ordinary
receipt that Jev sees. After a routine verdict, the worker links that proof
to the model call as a correct outcome. Every other case remains unknown.
The Jev rollout gates remain off.

## What to Tell Your User

We can now verify one simple result independently: the grading job had nothing
to grade and ran without changing its cursor. This will help measure Jev when
the guarded trial starts. Results with any grading history still need stronger
outcome checks, so Jev is not live yet.

## Summary of New Capabilities

- Scheduled grading passes with a truly empty quality ledger can record a
  separate idle effect proof.
- The job-supervision worker links that proof to a later routine verdict as
  one independently graded model outcome.

## Evidence

Unit tests cover empty, nonempty, unreadable and late-behind-cursor cases;
store migration and worker linking; authenticated route tests; and a
production boot test with the real scheduler journal. Full-suite and CI are
release gates.
