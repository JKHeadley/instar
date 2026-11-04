<!-- bump: patch -->

## What Changed

Agents on several machines can now read whether their machines could serve conversations across each other. `GET /session-pool/readiness` reports line by line per peer, and an hourly history goes to `logs/pool-readiness.jsonl`. It only reports: it writes no config, no stage and no signed result. `instar pair` and `instar join` now say so when automatic takeover does not work because the pair has no git remote. The description of the `shadow` stage is corrected: it places conversations for real.

## What to Tell Your User

If you run me on several machines, I can now tell you plainly what would and wouldn't work if conversations moved between them, or if one machine died. Nothing about how I run has changed.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Pool readiness report | `GET /session-pool/readiness` |
| Readiness history | `logs/pool-readiness.jsonl` |
