# No Silent Degradation to Brittle Fallback (+ Iterative Audit to Convergence)

**Status:** active initiative · **Owner:** Echo · **Origin:** Justin, 2026-06-07, topic 19437 (surfaced by the EXO 3.0 harness work, where an LLM refusal-judge fell back to a brittle keyword check under rate-limit and missed the very reworded forbidden actions it existed to catch).

## Standard 1 — No Silent Degradation to Brittle Fallback

**When an LLM makes a judgment that gates a real action, it must NEVER silently fall back to a brittle heuristic on LLM failure (rate-limit, circuit-open, timeout, unparseable reply).** Silently degrading to a weak check is worse than no check — it *looks* protected while the real protection is gone. On LLM failure a safety-gating path must do one of:

1. **SWAP PROVIDER** — try another configured LLM provider (e.g. Codex) before degrading at all; or
2. **FAIL CLOSED** — block / require-approval / hold, never the permissive verdict; never a brittle heuristic standing in for the LLM.

Provider-swap is the *preferred* response; fail-closed is the **all-providers-down backstop**. Falling back to a heuristic is acceptable ONLY for genuinely **advisory / observability** paths that do not gate a real action (a metric, a digest, a signal-only sentinel) — and even then it must be logged, never silent.

### Classification rule (how to triage a fallback site)
- **SAFETY-GATING** (the LLM decision blocks/allows a real action, message, or external call) → MUST swap-provider or fail-closed.
- **ADVISORY / OBSERVABILITY** (read-only; informs but does not gate) → may degrade, but must log the degradation.

### Enforcement
- ✅ **Implemented:** `tests/unit/no-silent-llm-fallback.test.ts` — the forward ratchet. It enumerates every file that calls an `IntelligenceProvider.evaluate()` and requires each to either carry a safety marker (`DegradationReporter` / `gating: true` / `@silent-fallback-ok` / `@llm-fallback-ok`) OR be listed in the test's `REVIEWED_ADVISORY` map with a reason. A NEW callsite that is neither marked nor reviewed fails the test, forcing triage (swap / fail-closed / report / classify). `REVIEWED_ADVISORY` is the convergence ledger and is staleness-checked (an entry that later gains a marker, or stops being a callsite, must be removed).
- **Realization note (honest scope):** the ratchet is FILE-granularity (does this file's LLM call carry a marker or a reasoned advisory classification), not per-`catch` semantic verdict analysis. That catches the real risk — a *new* gating LLM call shipping a silent brittle fallback — while staying maintainable. A new gating `.evaluate()` added to an already-marked file is the one residual gap; gating calls now route their failure through `IntelligenceRouter` (swap-then-fail-closed) regardless, which closes most of it structurally.
- Every fallback site should carry an explicit comment declaring its classification + behavior. The legacy `@silent-fallback-ok` marker stays valid as a reviewed-intentional marker, but a gating path must fail closed / swap, never silently degrade.

## Standard 2 — Iterative Audit to Convergence

**An audit is never one-off.** A single pass has blind spots, and the fixes themselves reveal or introduce new issues. The standard cycle is:

> audit → fix → **RE-audit** → fix → … until a clean pass returns **zero new discoveries**.

Only a converged audit (a re-run that finds nothing new) may be called "thorough." This applies to security audits, safety audits, and any "find all instances of X" sweep. Track the rounds; do not declare an audit complete on round 1.

## Audit (round 1) — LLM-fallback-to-brittle-code

~20 LLM-fallback sites found. Most are advisory (safe to degrade). **2 are safety-gating AND fail OPEN** (the dangerous ones); 3 more are safety-gating but mitigated.

| Site | On LLM failure (before) | Class | Action |
|---|---|---|---|
| `ExternalOperationGate.consultLLM` (catch) | returned `proceed` (fail-OPEN) | SAFETY-GATING | **FIXED → `show-plan`** |
| `ContentClassifier` parse-fail + error catch | returned `safe` (fail-OPEN) | SAFETY-GATING | **FIXED → `sensitive`** |
| `MessagingToneGate` | fail-open after 120s rate-limit wait | gating (mitigated) | provider-swap candidate |
| `MessageSentinel` | pass-through (deterministic fast-path floor) | gating (mitigated) | provider-swap candidate |
| `InputGuard` | warn + degradation-log + attention escalate | gating (mitigated) | already loud |
| `IntentLlmJudge`, redteam pack, RelationshipManager, PromptGate, SalienceGate, … | heuristic / null | ADVISORY | degrade-ok (log) |

Right-pattern templates already in the tree: **`AnthropicSubscriptionRouter`** (try primary → swap to fallback on error → throw if both fail) and **`LLMSanitizer`** (fail-closed by default).

## Implementation plan
1. ✅ **Gate-flips** — `ExternalOperationGate` (`proceed`→`show-plan`) + `ContentClassifier` (`safe`→`sensitive`) fail-closed. Regression tests updated. (This PR.)
2. ✅ **Herd-aware provider-swap at `IntelligenceRouter.evaluate`** — on a RUNTIME provider failure, a SAFETY-GATING call (`attribution.gating: true`) walks the configured `componentFrameworks.failureSwap` framework list, skipping any whose circuit is open (no herd onto a stressed provider) and serving from the first healthy one; if every target is down the error re-throws so the caller fails CLOSED. Generalizes to ALL accessible providers (Claude / Codex / Pi / Copilot-via-Pi — each a separate harness+account+quota), so the same model reachable via multiple paths = redundancy. Non-gating calls keep today's propagate-to-heuristic behavior; default (no `failureSwap`) = unchanged. Marked gating: ExternalOperationGate, MessagingToneGate, MessageSentinel, IntentLlmJudge, InputGuard. Composes with the subscription-pool (account layer). (Structure > Willpower: wired once at the router every gate routes through.)
   - **Follow-up (Justin, 2026-06-07):** swap currently orders by *framework* (harness+account). It does NOT yet prefer a different MODEL FAMILY first, so a model down provider-wide could be tried via two paths before moving on. A model-family-diverse default order is the next increment — not over-built now.
3. ✅ **Lint** `tests/unit/no-silent-llm-fallback.test.ts` — file-granularity ratchet over every `IntelligenceProvider.evaluate()` callsite (marker OR reviewed-advisory), staleness-checked. Complements the existing `no-silent-fallbacks.test.ts` catch-block ratchet (which scopes to `monitoring/ messaging/ memory/ server.ts` and does NOT cover the `core/` gates).
4. ✅ **Re-audit to convergence (round 2)** — full re-sweep of all callsites on 2026-06-08 main (post-#991/#992): **44** `evaluate()` callsites. 14 carry `DegradationReporter`/`gating: true`; 7 carry `@silent-fallback-ok`; **23 reviewed-advisory** (catch returns a benign default — null/empty/degraded/relay/no-override — or fails in a benign direction; the two security-named ones verified fail-SAFE: `LLMSanitizer` → empty, `InputClassifier` → relay-to-human with a deterministic destructive-op floor). **Zero remaining dangerous fail-open gates** — the only two (`ExternalOperationGate`, `ContentClassifier`) were fixed in round 1 (#991). Convergence: this round found no new dangerous site; the lint now holds the line. A round-3 sweep should re-run after any new gate lands.
5. **Throwaway sandbox agent** for adversarial behavioral testing (separate initiative — identical org-intent, no real powers; never test forbidden-action behaviors against the live production agent).

## Constitution
Both standards belong in `docs/STANDARDS-REGISTRY.md` / the constitution. They are safety standards: the first prevents fake-safety from a degraded gate; the second makes "thorough" mean "converged."
