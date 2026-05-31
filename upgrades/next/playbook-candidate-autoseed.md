# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Framework-Onboarding Mentor System's "lessons for the next framework"
playbook now actually populates. Generalizable framework issues (the portable
lessons — `framework-limitation` and `instar-integration-gap`) are promoted from
`none` to `candidate` the moment they're terminally resolved (fixed or won't-fix),
which is the auto-suggestion step the spec (§13.6) defined but that had never been
implemented. A one-time, idempotent backfill on ledger startup seeds lessons that
were resolved before this existed. Without this, the onboarding playbook returned
an empty list even with a full ledger of hard-won lessons — they were logged but
never reached the next framework's onboarding.

The `candidate → extracted` step (canonizing a lesson into the reusable onboarding
checklist) is unchanged: it still requires a non-Echo attestation, so an agent
cannot canonize its own lessons.

## What to Tell Your User

Nothing required — this is internal mentor-system robustness. If asked: the
lessons learned onboarding one agent framework now actually carry forward to the
next one, instead of sitting unused in the ledger.

## Summary of New Capabilities

- `GET /framework-issues/playbook?targetFramework=X` now returns the generalizable,
  terminally-resolved lessons from prior frameworks (previously always empty because
  nothing ever moved an issue off `playbook_status='none'`).
- `FrameworkIssueLedger.backfillPlaybookCandidates()` seeds pre-existing eligible
  lessons; runs automatically and idempotently on ledger construction.

## Evidence

- Root cause: §13.6's `none→candidate` auto-suggestion was specified but never
  implemented — the only writer of `candidate` was the manual promote route, so a
  live ledger with 18 generalizable codex lessons (11 terminal) served `playbook: []`.
- Fix: deterministic auto-bump in `updateIssue` on terminal resolution + an
  idempotent constructor backfill; the `candidate→extracted` non-Echo attestation
  guard is untouched.
- Tests: +10 unit, +1 integration end-to-end; 192 ledger/mentor/route/E2E tests pass.
  `npm run lint` clean.
- Spec: docs/specs/PLAYBOOK-CANDIDATE-AUTOSEED-SPEC.md (+ ELI16 companion).
