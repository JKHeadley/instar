# Standby trusts live Codex work

## What Changed

Standby no longer reports an active Codex session as stuck after the working timer changes from seconds to minutes. An affirmative live framework signal also cannot be overridden by the weaker model-based stall assessment.

## Evidence

Reproduced with the captured `Working (2m 17s • esc to interrupt)` pane: before, the live detector returned false and a stalled model verdict produced an unstick notice; after, changing minute-form output remains working, while the same unchanged pane still reaches stall assessment.

## What to Tell Your User

Standby now distinguishes fresh visible work from a frozen working screen before warning that an agent is stuck.

## Summary of New Capabilities

- Recognizes Codex working timers in both seconds and minutes.
- Gives fresh deterministic terminal evidence precedence over a weaker model verdict.
