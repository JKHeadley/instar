# Side-Effects Review — mentor autoloop prompt: claim-check + ELI16-body rules

**Version / slug:** `mentor-prompt-tonight-gates`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane (one prompt line in a pure, unit-tested string builder; no control-flow change)`

## Summary of the change

`buildAutoloopGoal` (the durable goal prompt for the mentor autonomous-fix loop, `MentorAutonomousGuardian.ts`) gains one discipline line encoding two 2026-06-05 lessons: run `instar dev:claim-check` before starting a build (the double parallel-collision night — #802 vs the keychain spec, #810 vs #808), and write the `## ELI16` section into the PR DESCRIPTION from the start (the new required CI gate, hit live on #813).

## Decision-point inventory

- `buildAutoloopGoal` — modified — one appended prompt line; pure function, no behavioral branch added.

## 1. Over-block / 2. Over-permit

None — prompt text only. The loop's gates (budget, single-instance, dark-by-default `mentor.autonomousFix.enabled`) are untouched. A host overriding via `mentor.autonomousFix.goalTemplate` is unaffected (the override path bypasses the built-in string entirely, unchanged).

## 3. Drift note

The prompt references the `dev:claim-check` CLI (shipped in #813) and the ELI16 PR-body gate (shipped 2026-06-05). If either is ever removed, this line goes stale — both are referenced by name so a grep finds them.

## 4. Migration parity

None — src-internal constant; ships with the package.

## 5. Token/cost impact

~90 extra prompt tokens per autoloop cycle spawn. Negligible.

## 6. Rollback

Revert the commit; the prompt loses the two reminders (structural gates still enforce both server-side — this line just saves the cycle from discovering them red).
