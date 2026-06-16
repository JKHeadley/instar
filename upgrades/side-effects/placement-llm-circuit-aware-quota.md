# Side-Effects Review — Quota-aware placement must see the open LLM circuit

**Slug:** placement-llm-circuit-aware-quota
**Spec:** docs/specs/placement-llm-circuit-aware-quota.md
**Parent principle:** No Silent Degradation to a Brittle Fallback — a machine that cannot serve LLM work must report itself blocked, not present a healthy-looking signal that misroutes work onto it.

## What changed

`selfQuotaState()` (the capacity-heartbeat block `PlacementExecutor` reads) derived `blocked`
ONLY from the account-quota poll, ignoring the `LlmCircuitBreaker`. So a machine whose CLI was
actually rate-limited (circuit OPEN) could still report `quotaState:{blocked:false}` and
placement would route a session onto it that dies on arrival. Caught live (2026-06-16, the Mac
Mini) by the gold-standard live test of the multi-machine transfer.

Fix: extract `computeSelfQuotaState(quota, circuitAvailable)` into `src/core/selfQuotaState.ts`
(pure, unit-tested), OR-ing an open/half-open circuit (`!llmCircuitAvailable()`) into the block.
`server.ts` calls it with the live quota snapshot AND `llmCircuitAvailable()`.

## Blast radius

- **Multi-machine placement (the target):** a circuit-open machine is now excluded from
  placement; new sessions land on a machine that can serve them. This was BROKEN before — net
  improvement, strictly better whenever ANY machine is available.
- **All-machines-circuit-open:** identical to today's all-account-quota-blocked case —
  placement falls back to least-loaded and flags `all-machines-quota-blocked` (now possibly
  carrying `llm-circuit-open` reasons). Not a regression; nowhere good to route by definition.
- **Single machine:** no peers to compare; the existing all-blocked least-loaded fallback
  applies, unchanged.
- **Fail-open preserved:** only a positively-observed open circuit newly blocks. Missing info
  (no tracker + closed circuit, or any throw) → `undefined` = unknown ≠ blocked, exactly as
  before. A DISABLED breaker reports available → never a false block.
- **Wire field:** `quotaState` keeps its name (a replicated heartbeat field consumed
  cross-machine + by the dashboard; renaming is a separate wire migration). Its MEANING is
  pinned by the doc contract + a new `SelfQuotaBlockReason` enum (`llm-circuit-open` |
  `five-hour-exhausted` | `provider-block` | string). No consumer keys on a specific reason
  string, so widening the cause set is non-breaking.

## Reversibility

Governed by the existing `intelligence.circuitBreaker` config — disabling the breaker (or it
never tripping) keeps `llmCircuitAvailable()` true so this never blocks. Revertable by reverting
the two-file diff; no durable state is written (the block is recomputed per heartbeat).

## Risk / monitoring

Low. Pure-function change off the hot path (computed per 30s heartbeat). Observable via
`GET /pool` (`quotaState.reason: 'llm-circuit-open'`) + the existing placement decision flags +
the already-audited `[llm-circuit]` transitions in `logs/server.log`. Release gate: the live
two-machine re-run — a circuit-open machine shows `blocked:true` in `/pool` and a new
conversation lands on a machine that can serve it.
