<!-- bump: patch -->

## What Changed

The multi-machine session pool no longer places conversations onto a machine
whose LLM account is rate-limited or quota-blocked. Each machine's 30-second
capacity heartbeat now self-reports a `quotaState` (provider block in effect,
or the 5-hour window ≥95% — read strictly from that machine's OWN quota
tracker), and the placement engine:

- drops quota-blocked machines from the candidate pool (new placements,
  soft preferences, AND stickiness — a conversation currently on a machine
  that becomes blocked moves off it on the next message);
- still honors an explicit hard pin to a blocked machine (the user's command
  wins), flagged `pinned-machine-quota-blocked` so the user can be told why
  it's quiet;
- falls back to least-loaded-among-blocked when EVERY machine is blocked,
  flagged `all-machines-quota-blocked`.

Older machines that don't report the field are treated as not blocked —
mixed-version pools behave exactly as before. `GET /pool` shows each
machine's `quotaState`.

## What to Tell Your User

Your messages stop landing on a machine whose AI account has hit its limit —
the pool quietly routes conversations to a machine that can actually answer.
The only way to stay on a rate-limited machine is to have pinned the
conversation there yourself, and then I can tell you exactly why it's quiet
and when the limit resets.

## Summary of New Capabilities

- Per-machine `quotaState` in capacity heartbeats + `GET /pool`.
- Placement avoids quota-blocked machines; blocked owners lose stickiness.
- Hard pins win with a `pinned-machine-quota-blocked` flag; all-blocked
  pools place least-loaded with `all-machines-quota-blocked`.

## Evidence

`tests/unit/PlacementExecutor.test.ts` +8 (including the verbatim incident
case — a quota-blocked current owner loses stickiness) with all 29
pre-existing placement tests green; `tests/unit/MachinePoolRegistry.test.ts`
+1 (passthrough + clears on a quota-free heartbeat). tsc + lint clean.
