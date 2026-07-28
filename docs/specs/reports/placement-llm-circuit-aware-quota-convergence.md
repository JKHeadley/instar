# Convergence Report — Quota-aware placement must see the open LLM circuit

## Cross-model review: codex-cli:gpt-5.5 (RAN, clean); gemini-cli (degraded this round)

Codex ran successfully each round (the clean RAN cross-model pass). Gemini degraded on the
final round (call timeout) — a partial pass folded in; codex provided the genuine outside
opinion throughout.

## ELI10 Overview

Placement is supposed to skip rate-limited machines, but the "quota" flag it reads ignored the
circuit breaker that trips when a machine's AI calls actually fail. So a machine could say
"not blocked" while its circuit was open and it couldn't answer — and placement routed a real
session onto it, which died (caught live on the Mac Mini). The fix makes the flag OR-in the
open-circuit state, extracted into a testable pure function.

## Origin

Found by APPLYING the gold-standard live test to the multi-machine transfer (topic 13481): a
real Slack message routed to the Mini, whose `/pool` reported `quotaState:{blocked:false}`
while `[llm-circuit] OPEN` was in its log; the handed-off session died → stall notice.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | conformance (2), codex (MINOR) | Testing/E2E tier; observability; signal-conflation (quota vs execution health) | Added semantic-contract + consumer audit; Observability section; Tier-3 live-E2E gate |
| 2 | conformance (1: obs), codex (MINOR) | `quotaState` name now misleading | Added `SelfQuotaBlockReason` enum (type-level cause); documented name retained for wire-compat (rename = separate migration); tuning lever |
| 3 | conformance (1: obs), codex (MINOR), gemini (degraded) | all-circuit-open fallback still routes into failure | Documented as inherent (identical to today's all-quota-blocked), not a regression; honest flag surfaces it |
| — | (converged) | 0 material-new | — |

## Standards-Conformance Gate

Ran every round (22 standards). Settled at ONE recurring advisory (Observability — "add a
metric"), addressed proportionately: the cause is a low-frequency already-logged circuit
transition, surfaced via `/pool` `reason` + placement decision-flags + the breaker config as
the tuning lever; a dedicated counter is judged gold-plating, with the `reason` enum as the
ready aggregation key if that judgment ever flips. Signal-only; non-blocking.

## Convergence verdict

Converged. Codex descended MINOR→MINOR→MINOR; every finding was a refinement or an inherent
limitation honestly documented (not a redesign), all folded; zero open questions. The fix is
surgical and testable (a pure `computeSelfQuotaState` gated on `llmCircuitAvailable()`),
fail-open preserved (unknown ≠ blocked), and strictly improves placement whenever any machine
is available. Ready for approval.
