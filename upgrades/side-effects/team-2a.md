# Side-Effects Review — Team access for one-machine agents (step 2a)

**Version / slug:** `team-2a`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `required before the PR opens`

## Summary of the change

Builds step 2a of docs/specs/team-roles-and-access.md §4.1 in pieces, with the invite route last, so team access cannot be turned on until every guard exists. So far: the role map, event validators, the signed access log and confined list, the `team` phone role, route tiers, and the conversation check by operation. No team phone can exist yet, so owner and `msp` behaviour is unchanged.

## Decision-point inventory

`mayDoAsTeam`, the fold's standing check, and the confined list: invariant, per the spec's decision table.

## 1. Over-block

None in this piece: nothing is wired.

## 2. Under-block

None in this piece.

## 3. Level-of-abstraction fit

A pure role map in `src/permissions`, the store in `src/core`, beside the other signed stores.

## 4. Signal vs authority compliance

Authorization is deterministic by design, per the spec. No brittle check holds judgment authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

Invariants, classified in the spec.

## 5. Interactions

None yet.

## 6. External surfaces

None yet.

## 6b. Operator-surface quality

None yet.

## 7. Multi-machine posture (Cross-Machine Coherence)

2a is one machine by decision (spec §4.1). The row format is built for 2b's replication.

## 8. Rollback cost

A plain revert: nothing reads these files yet.

## Class-Closure Declaration (display-only mirror)

No self-triggered action in this piece.

## Second-pass review

Pending, before the PR opens.

## Conclusion

Foundation only.

- Added: confined list reader, per-topic reply guard, spawn refusal, intercept skip, scoped stop, confined inbox for app context and files, stored speaker names.

- Added: Team routes: owner-only invites, grants and people changes store the phone's signed request; the agent token can only lower; attention and session filters, join refusal, conversation lock and reshape are in.

- Added: Tests: status table across all allowlist routes, route tests with both sides of each role check, full journey on a real AgentServer. Added team access awareness to the template and migrator, and the scheduled-jobs disclosure to the invite and first-use answers.

- Added: Live run on a test agent found Activity showing 'Someone was removed' after a removal; names now come from the log.

- Added: Spec wording: attention filtering reads contextTopicIds only; the journey test now checks the history by name.

- Added: Spec wording: attention filtering reads contextTopicIds only; the journey test now checks the history by name.
