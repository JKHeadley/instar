# Side-Effects Review — Herd-aware provider-swap

**Version / slug:** `provider-swap` · **Date:** `2026-06-07` · **Author:** `Echo` · **Second-pass:** `not required (Tier-1)`

## Summary of the change
`IntelligenceRouter.evaluate` now, on a RUNTIME provider failure for a SAFETY-GATING call (`attribution.gating: true`), walks `componentFrameworks.failureSwap` (ordered frameworks), skips circuit-open targets, serves from the first healthy one, and re-throws if all are down (caller fails closed). New `failureSwap` config field + `gating` attribution flag. 5 safety-gating callers marked gating (ExternalOperationGate, MessagingToneGate, MessageSentinel, IntentLlmJudge, InputGuard).

## Decision-point inventory
- `IntelligenceRouter.evaluate` failure path — add (swap-on-failure for gating calls)
- `ComponentFrameworksConfig.failureSwap` — add (opt-in)
- `IntelligenceOptions.attribution.gating` — add (opt-in marker)

## 1. Over-block / Under-block
No allow/deny surface. The swap only changes WHICH provider answers a gating call on failure; the gate's own verdict logic is unchanged. Non-gating calls and the unconfigured default are byte-identical to before.

## 2. Data / state
None. No files, no schema, no persistence. Pure in-memory routing.

## 3. Performance
On the FAILURE path only, a gating call may make up to N extra provider attempts (N = failureSwap length), each short-circuited by its own breaker if open. The happy path (provider healthy) is unchanged — one call. No hot-path cost added.

## 4. Failure modes / herding
This IS failure-mode handling. Herding is bounded two ways: only gating calls swap (small set), and circuit-open targets are skipped (no load onto a stressed provider). All-down → re-throw → caller fails closed. No infinite loop (finite list, `target===framework` skipped).

## 5. Security / auth
Hardens availability of the safety gates (they get a working provider before failing closed). No new endpoints/capabilities/credentials. The swap reuses already-wired per-framework providers.

## 6. Migration / compatibility
No migration. Default (no `failureSwap`) = unchanged behavior. Opt-in per agent via `componentFrameworks.failureSwap`. `gating` is additive on attribution (ignored by old code paths).
