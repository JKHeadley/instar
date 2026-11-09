# Upgrade Guide — usage-limit-watch

## What Changed

New `UsageLimitWatch` (fb-cab84278-0b4). With one account, or none with room, a usage limit proven by the serving session's transcript or a real probe now tells the operator once, replaces the standby's "actively working" line, shows as `claudeUsage` in `GET /health`, and is probed until usage returns. Then conversations with held messages restart with those messages quoted and are checked for a real reply. A new CLAUDE.md bullet reaches existing agents through PostUpdateMigrator.

## What to Tell Your User

If I run out of Claude usage and have no other account to use, you'll now hear about it right away, including when it resets and how to add capacity. Anyone who messages me is told too. When usage comes back I pick up waiting conversations myself.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Told when Claude usage runs out; conversations pick up afterwards | Automatic |
| Current state in `claudeUsage` on `GET /health` | Ask me why I went quiet |

## Evidence

`tests/unit/usage-limit-watch.test.ts` covers both sides of each decision, the standby and the wiring; `tests/e2e/usage-limit-watch-alive.test.ts` runs a whole episode through a restart. Original silence traced to the old limit patterns in v1.3.1651 missing "weekly". Real transcripts confirm the row the proof reads (`error: rate_limit`, status 429). No live run yet; a cloud test agent run follows release, and must also confirm the CLI's error text.
