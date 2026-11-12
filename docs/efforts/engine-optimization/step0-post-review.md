# Step 0 post-review: chartering Engine Optimization

Written 2026-11-11 by Echo. Step 0 ran from 10:09 to 14:25 PST and ended with the charter sent for Justin's own-words approval.

## What went well

- The three-reviewer meta pass (Echo, Fable 5.2, GPT 6 Astra) produced real corrections Echo would have missed. It found the existing constitutional home for this effort (Framework-Agnostic — and Framework-Optimizing). It showed the March audit was stale on paper, not abandoned. And it caught that the brief leaked Echo's conclusions.
- Both constitution books are now snapshotted in the effort folder, so later reviews run against the full authority.
- Spec-converge on the confirm tap worked as a detector. It found a real replication trap (an unknown record type halts a peer's whole journal stream, fb-d85c05cd-fa7) and real weaknesses in the PIN path. It also stopped at the round cap and reported the failure honestly instead of patching quietly.

## What went badly

| Problem | Cost | Root cause | Action taken |
|---|---|---|---|
| The first meta pass was solo | One correction round from Justin | The process existed only in Echo's head | Multi-model review is now the default in every stage brief; recorded in MEMORY.md |
| The required fix (confirm tap) grew from about 1,000 to about 5,000 words over 6 rounds and blocked the step | About 3 hours of a 4-hour step, plus a stall | No size check on "required" fixes; scope kept growing through rounds 1-3 | Rule recorded for sub-effort C: a required fix gets the same S-size check, and a scope split comes after round 3. The fix was spun off, and the interim path is approval in Justin's own words |
| **The session stalled for about 2.5 hours** waiting on a yes/no from Justin | Justin had to check in | Echo ended a turn on a question whose recommended answer was reversible and in scope | This is the anti-stall gap the effort process promised to close. Action: from now on a stage only waits on Justin for decisions that are his by the charter (approve the charter, settle a material disagreement, accept a degraded review). Everything else proceeds and is reported. Also recorded in MEMORY.md |
| Telegram delivery from the M5 standby was invisible or ambiguous | Justin missed replies; one resend | The local outcome check can't see the lease holder's records (fb-b3f32991-c79) | Outcomes are now checked on the Studio; feedback filed |
| Links to the Studio's private pages were blocked from the M5 | The summary went out without a link | URL provenance check (fb-697c1551-325) | Filed; summaries go out as text |
| Concurrent review rounds read different spec versions | Round 2 findings were partly stale | No frozen spec hash per round | Rounds 5 and 6 used frozen copies; rule recorded for sub-effort B |

## Did the meta process itself work?

Partly. The pre-review found the right first improvements. But the "do the step" phase had no time box and no stall guard, so one fix ate the step. The post-review ran only because the round cap forced it. Two gaps for the stage-gate design (sub-effort C):

1. Every stage needs a time and round budget. When it runs out, the stage either proceeds on an interim path or asks for one named decision. It never sits idle.
2. A stage that waits on the owner must name the exact decision and keep doing any work that decision doesn't gate (here, step 1 research could have started at 11:45).

## Findings filed

- fb-b3f32991-c79, fb-697c1551-325, fb-bd29c0d4-7e0, fb-fcc1d0e1-104, fb-d85c05cd-fa7: platform bugs, via the feedback API.
- Initiatives: `cos-charter-confirm-tap` (restart with the simpler design), `sealed-multimodel-review` (sub-effort B), `effort-stage-gate` (sub-effort C, with the budget and stall rules above), `cos-charter-edits`, `cos-charter-app-card`, `cos-done-item-fetch-guard`.
