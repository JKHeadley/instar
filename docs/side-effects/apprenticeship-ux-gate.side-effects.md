# Side-effects review — apprenticeship-ux-gate

## Change surface

1. `ApprenticeshipCycleStore`: new required `operatorSeatUx` block validated in
   `record()` (self-describing refusal), new `operator_seat_ux_json` column
   (CREATE TABLE + idempotent ALTER migration mirroring the `channel` pattern),
   parsed back on reads (legacy/empty → `null`).
2. `MentorAutonomousGuardian.buildAutoloopGoal`: step 3a now teaches the
   operator-seat counting + file-each-compensation rule; new step 5 requires
   recording the cycle with the block and explains the 400 refusal.
3. Tests updated at all three tiers + new gate tests (refusal both sides,
   round-trip, legacy-row grandfathering, HTTP-side refusal).

## What could this affect?

1. **The live mentor loop** — the next cycle that POSTs /apprenticeship/cycles
   without the block gets a 400 naming the exact required shape. This is the
   intended behavior (refusal = the observation didn't happen). The prompt
   that produces the block ships in the SAME release, so the producing side
   and the gate deploy together. Risk: a cycle recorded by an older session
   (spawned pre-update) is refused until that session restarts — acceptable;
   the refusal message is self-serve and cycle recording is end-of-cycle.
2. **Existing databases** — idempotent ALTER adds the column with DEFAULT '';
   legacy rows read as `operatorSeatUx: null` (grandfathered, mirroring
   `channel: 'unknown'`). No data rewritten, keystone/coverage logic untouched.
3. **HTTP API consumers** — POST /apprenticeship/cycles contract narrows
   (new required field). Known callers: the mentor loop (updated here) and
   manual overseer records (operator-driven; refusal message self-describes).
   GET responses gain `operatorSeatUx` (additive).
4. **roleCoverage / SLA monitor / keystone** — read paths unchanged; the new
   field is carried, never consulted, by those computations.

## What this deliberately does NOT do

- No auto-filing wiring from counts → framework-issue ledger (the prompt
  instructs it; the structural auto-filer is fix B — Codey's post-drive
  transcript auditor, which removes mentor judgment entirely).
- No dashboard surface for the UX verdicts yet (follow-up once B lands data).
- No backfill of legacy rows (grandfathered honestly as null).

## Rollback

Revert the PR. The added column is inert under old code (SELECT * tolerates
it); old record() simply stops requiring the block. No data migration to undo.
