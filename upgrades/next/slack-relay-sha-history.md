# Upgrade Guide — Slack relay migration repair

<!-- bump: patch -->

## What Changed

Existing Slack agents whose reply script came from the 2026-11-03 Instar release now get the current packaged script during migration, with the prior file backed up. Locally customized reply scripts stay untouched and continue to receive a `.new` candidate for review. CI now checks Slack template history so a future release cannot omit a prior shipped script hash unnoticed.

## What to Tell Your User

Slack replies should work again after your agent updates. If your agent has a locally customized Slack reply script, its custom file stays in place and Instar reports that it needs review.

## Summary of New Capabilities

No new capability; this repairs update migration for existing Slack agents.

## Evidence

The historical script hash was recovered from the shipped git commit. Unit tests cover upgrade and custom preservation; integration tests run the real migrator; a packed CLI smoke test upgraded both installed script locations; the history lint fails when the hash is removed.
