# Observable Intelligence — Auditable Autonomous LLM Action

**Status:** proposed 2026-06-07 (pending operator ratification)
**Parent constitutional standard:** *Observable Intelligence — No Autonomous LLM Action Is Unauditable* (docs/STANDARDS-REGISTRY.md), which sharpens *Observability — you can't tune what you can't see* and is balanced by the *Bounded Notification Surface* / Responsible-Resource discipline.

## Why

An operator asked the plain question: *"are the sentinels actually using codex, and are they doing any real work?"* The honest answer was *we could not fully tell*:

1. **Provider/model was never recorded.** The `FeatureMetricsLedger.model` column existed but the funnel never populated it — every row stored `model = NULL`. There was no way to confirm, from the metrics, which provider a sentinel ran on.
2. **Token cost was blank on the codex path.** Token usage reached the funnel only via `IntelligenceOptions.onUsage`, which only `ClaudeCliIntelligenceProvider` calls — so codex/gemini/pi calls recorded `NULL` tokens (the e5d1c295 blind spot).
3. **Effectiveness was unrecordable.** The ledger's `fired` outcome (the sentinel *acted*) was deferred to a "Phase 2" that never shipped, so every completed call recorded as `noop`. `fireRate` was therefore structurally 0 — the metrics could not say whether a sentinel ever earned its keep.

A system that acts on the user's behalf but cannot show *what it chose to do and how it decided* is incoherent on the accountability axis.

## What it requires

Every LLM call the system makes on its own behalf is recorded with: component, **resolved provider + model**, outcome (`fired` | `noop` | `error` | `shed`), token cost where the provider surfaces it, latency, timestamp.

## Architecture (Structure beats Willpower)

Recording is enforced at the **single funnel** — `CircuitBreakingIntelligenceProvider`, which every `IntelligenceProvider` is wrapped by — so a new LLM-driven feature is auditable the moment it routes through the funnel, with no per-feature logging to remember.

Two additive, optional seams on `IntelligenceOptions`:

- **`onModel({ model, framework })`** — every provider (Claude/Codex/Gemini/Pi/InteractivePool) invokes it once per call, *independently of token usage*, so the providers that surface no tokens are still attributable. The funnel captures it and records `model` + `framework` on the row — including on the error path (a failed call is attributed to its provider too).
- **`classifyVerdict(result) → { acted, verdictId? }`** — the caller classifies whether *this* call led the system to act. The funnel calls it on the successful result (wrapped in try/catch; defaults to `noop`) and records `fired` vs `noop`, making `fireRate = fired / realCalls` meaningful. Wired into `MessageSentinel` (non-`normal` category) and `CommitmentSentinel` (≥1 genuine commitment detected) as the proof callers; available to all.

Both are pure side-channels: a throw in either can never change what `evaluate()` returns or break the observed path.

### Token usage by provider

- **Claude** (`claude -p --output-format json`): full token usage via `onUsage` (pre-existing).
- **Pi** (`pi -p --mode json`): `OneShotCompletion` surfaces `message.usage`; forwarded via `onUsage`.
- **Codex / Gemini**: their non-JSON exec output carries no usage block; per-call tokens remain `NULL`. Model/framework attribution is still recorded (the airtight "which provider" answer), and account-level cost is observable via `/codex/usage`. Per-call token parsing for these would require switching to their `--json` event-stream modes — a separate, riskier change tracked as a bounded follow-up.

## Bounded retention (Responsible Resource)

`FeatureMetricsLedger.pruneOlderThan(cutoffMs)` ages out old rows. `AgentServer` prunes once at boot and every 6h, keeping `monitoring.featureMetrics.retentionDays` (default 30; `0`/negative disables) days of trail — long enough to see trends, never hoarded forever.

## Read surfaces

- `GET /metrics/features?sinceHours=N[&feature=X]` — per-feature rollup now including `frameworks[]`, `models[]`, `fired`, `fireRate`, `shed`, token cost, latency p50/p95.
- The **Sentinel Effectiveness** dashboard tab renders this in plain language over a selectable window.

## Signal, never authority

The ledger is read-only observability (same guarantee as TokenLedger): it never gates, blocks, throttles, or mutates the path it observes. A failed metric write, a failed prune, or a thrown `classifyVerdict` degrades silently and the LLM path is byte-identical.

## Schema migration

The new `framework` column is added idempotently at ledger open (pragma-guarded `ALTER TABLE ADD COLUMN`), so an existing `feature-metrics.db` gains it without data loss; the `model` column predates this change.
