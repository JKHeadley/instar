<!-- bump: patch -->

## What Changed

Wires the Gemini multi-turn loop-driver engine (`need-gem-002`, increment 1,
already merged) into a real, budget-gated, **dark** capability — so the Gemini
mentee can be handed a goal it works across turns instead of one reply.

- `geminiLoopProduction.ts` — the production dependencies: a subscription-auth
  spawn (routes through the billing-env-stripping gemini transport, so no run can
  introduce an API key), a `gemini --list-sessions` handle parser that picks the
  freshest session by age, and a budget gate that reuses the existing QuotaTracker
  spawn-admission signal (fails open if no tracker).
- `GeminiLoopRunner` — a multi-turn run can take minutes, so `POST` ADMITS a run
  (enabled? under the concurrency cap? budget open?) and returns a `runId`
  immediately; the loop runs in the background and the result lands in a bounded
  in-memory registry.
- Routes `POST /gemini-loop/runs` + `GET /gemini-loop/runs[/:id]`.
- Config `autonomousSessions.geminiLoopDriver` (`enabled`, `model`, `maxTurns`
  default 12, `minTurnIntervalMs`, `maxConcurrent` default 1, `turnTimeoutMs`).

Ships **dark** behind `autonomousSessions.geminiLoopDriver.enabled` (default
`false`); the `developmentAgent` gate turns it on for development agents only.
Rollback = set the flag `false` (instant, no redeploy). Subscription auth is
structural. 21 new tests across all three tiers (unit + integration route + e2e
alive + wired-source check). Spec: `docs/specs/gemini-multi-turn-loop-driver.md`.

## What to Tell Your User

On development agents I can now be handed a multi-step task for the Gemini side
and work it across several turns on my own — on subscription login, never an API
key — with a hard turn cap and a spend gate so it can't run away. On every other
agent it ships turned off, so nothing changes there. This is the capability the
apprenticeship program needed so the Gemini mentee can do real multi-step work
instead of stopping after one reply.
