# Side-effects — Mentor Stage-A no-leak compose instruction

## 1. What files/state does this touch at runtime?
`src/monitoring/MentorStageA.ts` only — one added instruction line in the
`buildStageAContext` prompt string. No new state, config, schema, endpoint, or
dependency.

## 2. Does it change any functional behavior?
Only the wording of the Stage-A compose prompt handed to the mentor's compose LLM.
The LLM is now explicitly told not to name source paths / file:line / PR-issue
numbers / SHAs. The leak detector (`detectStageALeak`), the tool grant
(`STAGE_A_ALLOWED_TOOLS`), the spawn path, history-bounding, and all non-mentor code
are unchanged.

## 3. What happens on failure / weird config?
No failure mode introduced — it is a static prompt string addition. If the compose
LLM ever ignores the instruction, the (untouched) `detectStageALeak` still catches
the leak exactly as before; the only effect is the finding fires far less often.

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — code-only, compiled into `dist`. No agent-installed
file / config / template change → no `PostUpdateMigrator` pass.

## 5. Could it spam / flood / burn resources?
The opposite — it REDUCES noise: it cuts the recurring `stage-a-leak` ledger finding
(impactScore ~130) that fired on nearly every tick. No new I/O, timers, or LLM calls
(the prompt is marginally longer by one sentence).

## 6. Rollback / off-switch?
Remove the one instruction line. No data, no migration, no flag. Behavior returns to
the prior (leak-prone) compose wording.

## 7. Concurrency / ordering?
None — `buildStageAContext` is a pure synchronous string builder. The added line is
in the fixed preamble, before the conversation/agenda blocks; ordering of the rest
is unchanged.

## Blast radius
Minimal + mentor-only. One line in one pure function. The detector and canary that
police two-hats integrity are deliberately untouched, so enforcement strength is
unchanged — this only stops the mentor from generating the leak in the first place.
Affects only mentor-enabled agents (the mentor ships dark on most), and only the
wording of the compose prompt.
