---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "Yes, I agree. Please proceed." in response to my Option 3 / focused-first-cut proposal — ship framework + the externalized-config-boot scenario as a working backstop, then expand)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Pipeline post-mortem lever B: a new test category for real-world-state
scenarios.** Closes the broader pattern #1 from the 2026-05-29 post-mortem
— "Tested on fresh state, not real-world state" — which was the largest
of the five named bug classes (PRs #534, #512, #509, #501, #503, #542
all instances).

`tests/real-world-state/` joins `unit/`, `integration/`, and `e2e/` as a
peer test category. Scenarios in it exercise instar against state that
LOOKS LIKE a real production agent (externalized secrets, multi-100MB
DBs, wrong-ABI binaries, concurrent state, etc.) rather than the small
fresh-fixture state the existing suites use.

A two-tier system controls CI cost:

- **'pr' tier** runs every CI shard. Small fixtures, < 30s setup.
- **'nightly' tier** is gated on `INSTAR_REAL_WORLD_BIG=1` env. Default
  OFF. For multi-100MB DBs, wrong-ABI binary swaps, concurrency-at-scale
  scenarios. The skip is loud (`describe.skip` with a clear message) so
  the coverage gap is visible, not silently absent.

The first scenario — `externalized-config-boot` — targets the #542
incident class. It asserts that `loadConfig()` (the canonical
production read path) merges the real `authToken` string back from the
secret store when the on-disk config holds `{ "secret": true }`, plus
the same for telegram token/chatId, dashboard PIN, and tunnel token.
5 tests; verified positive AND destructive-negative (disabling the
merge call trips 4 of the 5 with the failure modes the bug produced).

This is the LAST recommended post-mortem lever. PR #542 (silent-403)
through #552 (bare-catch ban) closed individual incident classes; THIS
one closes the broader pattern that produced them.

**Multi-machine: a standby machine no longer steals your Telegram
messages.** Telegram allows exactly one connection per bot to receive
messages. When you ran one agent across two machines, BOTH machines tried
to receive — so the messaging service handed each message to one of them
at random, and about half landed on the machine you weren't watching
(looking like the agent ignored you). A standby machine can now be told
"don't own the Telegram connection": it runs the full server and stays a
full member of the machine pool (so work can move to it), but it never
opens the receive connection — only the primary machine does. The default
is unchanged (every existing single-machine agent keeps receiving exactly
as before); only a machine explicitly set to standby stops receiving.

## What to Tell Your User

Nothing visible in normal operation. If you want to run the big
fixtures locally before pushing, set the INSTAR_REAL_WORLD_BIG environment
variable when you run the tests to enable the nightly tier. The CI default
is the PR tier only.

If you run one agent across two machines: the second machine can now be a
silent standby that helps with work but never grabs your messages — no
more "I messaged it and got no reply" from a background machine. Nothing
to do on a single-machine setup.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `tests/real-world-state/` test category | Add a new scenario file there. Use `describeAtTier('pr', …)` or `describeAtTier('nightly', …)`. |
| Tier-gated execution | 'pr' runs every shard; 'nightly' skips unless `INSTAR_REAL_WORLD_BIG=1`. |
| `makeAgentFixture()` helper | Per-test scratch dir simulating an agent home (projectDir + .instar/). Returns a cleanup callback. |
| Externalized-config-boot regression check | `loadConfig()` against the externalized shape is asserted on every PR. #542's class can never regress silently. |
| Standby-no-poll Telegram guard | Set `multiMachine.telegramPolling: false` in a standby machine's config — it runs the full server + joins the pool but never owns the Telegram poll. Default (unset) = poll, so existing agents are unchanged. |

## Evidence

- 5 new tests in `tests/real-world-state/externalized-config-boot.test.ts`,
  all green. Tier system verified both directions (sentinel test).
- Destructive-negative verified: disabling `mergeConfigWithSecrets()` in
  `Config.ts` trips 4 of the 5 tests with the exact failure modes
  (`{ secret: true }` returned as authToken, telegram token leaks, etc.).
- Existing `secret-migrator.test.ts`, `config-secret-merge.test.ts`,
  `secret-store.test.ts` remain green (no regression in adjacent code).
- `tsc --noEmit` clean.
- Side-effects review:
  `upgrades/side-effects/real-world-state-fixture-framework.md`.
- Standby-no-poll guard: `tests/unit/lifeline/telegramPollOwnership.test.ts`
  (5 cases — both sides of the default-true boundary) +
  `tests/unit/lifeline/standby-no-poll-wiring.test.ts` (6 cases — the
  lifeline gate wraps flush+poll, supervisor + queue replay stay outside
  it, the suppressed branch sets polling=false and logs it). 11/11 green;
  `tsc --noEmit` clean. Side-effects:
  `upgrades/side-effects/standby-no-poll-guard.md`.
