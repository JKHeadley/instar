# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Phase two of the token-burn-detection-and-self-heal system. Still observation-only — no alerts, no auto-throttling, no new dashboard. This phase adds the piece that figures out which component made each LLM call after the fact.

What lands today:

- A short list of patterns that match the prompt shapes the agent's internal components produce.
- A pure function that takes a token-ledger event and returns a stable attribution identifier.

The detector in phase three will use this function to group calls by where they came from. Nothing in production calls the new function yet.

## What to Tell Your User

Your agent picked up the second of six pieces of the new self-watch system. Like the first piece, nothing changes about how your agent behaves today. The watcher you approved is being built in stages so each piece can be reviewed on its own.

For now, no action needed. The third piece is the one that will start actually noticing things.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Read-side attribution resolver | Internal — no surface yet. |
| Static attribution manifest | Internal — covers nine known components. |

## Evidence

Twenty-two new tests in `tests/unit/burn-detection-phase-2.test.ts` all pass. The resolver is a pure function with no I/O and no dependency on time, so the test suite is deterministic. Manifest integrity tests cover uniqueness of component names, non-empty entries, and at-least-one-matcher per entry.

The existing token-ledger and selectIntelligenceProvider unit suites still pass — no regression on the parts not touched by this phase.

Side-effects review for this phase is in `upgrades/side-effects/token-burn-detection-phase-2.md`. The reviewer identified zero blocking concerns; phase two ships pure inference with no runtime decision authority, so second-pass review is not required per the instar-dev skill criteria.
