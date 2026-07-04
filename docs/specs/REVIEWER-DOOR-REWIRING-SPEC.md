---
title: "Reviewer-Door Rewiring — strongest model via a clean door per provider for the spec-converge reviewers"
slug: "reviewer-door-rewiring"
author: "echo"
status: "draft"
parent-principle: "Structure beats Willpower"
extends:
  - "src/core/crossModelReviewer.ts (SUPPORTED_REVIEWER_FRAMEWORKS / TRUSTED_REVIEWER_FRAMEWORKS registry)"
  - "src/core/ClaudeCliIntelligenceProvider.ts (the existing claude -p door)"
  - "src/core/intelligenceProviderFactory.ts (buildIntelligenceProvider — provider construction, breaker wrap, subscription router arm)"
  - "src/core/models.ts (resolveCliFlag / tier resolution — the 'capable'→opus alias)"
  - "src/core/devGatedFeatures.ts (DEV_GATED_FEATURES + resolveDevAgentGate — the maturation-path gate)"
  - "src/core/PostUpdateMigrator.ts (migrateConformanceGateAutoInvoke — the SKILL.md migration precedent)"
  - "src/core/claudeForbiddenGuard.ts (assertClaudeAllowed — the codex-only-agent throw)"
  - "docs/LLM-ROUTING-REGISTRY.md (door-penalty findings, task-nature taxonomy)"
  - "scripts/model-registry-freshness.manifest.json + scripts/lint-model-registry-freshness.mjs (Keep the Doorway/Model Map Current)"
  - "docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md (the doorway registry this spec consumes)"
eli16-overview: "docs/specs/REVIEWER-DOOR-REWIRING-SPEC.eli16.md"
lessons-engaged:
  - "Structure beats Willpower — reviewer doors live in a typed registry + a dev-agent gate + code-enforced clamps, not in prose about which model or timeout to use (parent principle)"
  - "Signal vs. Authority — reviewer passes are signals into convergence; nothing here gains blocking authority (engaged, §6)"
  - "Verify the State, Not Its Symbol (P20) — the claude entry passes the RESOLVED concrete model id into evaluate(), and a unit test pins evaluate-arg == flag-model, so the flag can never advertise a model the invocation did not use (engaged, §1.3, §1.4)"
  - "Keep the Doorway/Model Map Current — every concrete model pin this spec adds is registered in the freshness manifest with a real reviewed row under the strict lint (engaged, §1.3)"
  - "Intelligent Prompts / bench honesty — the door penalty is applied where it was MEASURED (Anthropic coding-harness door, bounded verdicts), not smeared over unmeasured doors; the door taxonomy is named honestly (engaged, §2, §4)"
  - "Token-Audit Completeness — the new reviewer family calls ride buildIntelligenceProvider with attribution.component so every token is attributed (engaged, §1.4)"
  - "Bounded Blast Radius — reviewer calls ride the host spawn-cap funnel + the account-global circuit breaker; families run sequentially per round; a rate-limited claude round short-circuits the family for the rest of the convergence; rounds hard-capped at 10 (engaged, §7)"
  - "Maturation Path — Every Feature Ships Enabled on Developer Agents — the anthropic reviewer rides resolveDevAgentGate (live-on-dev / dark-on-fleet), NOT a hardcoded default-false flag (engaged, §1.5)"
  - "Migration Parity — the SKILL.md content edit ships with a marker-gated PostUpdateMigrator migration so deployed agents' installed skill copy is updated (engaged, §Migration parity)"
  - "Cross-Machine Coherence / P21 — reviewer availability is per-disk CLI logins; declared machine-local with the closed-taxonomy justification; the D8 trigger reads the git-tracked reports (unified), not per-machine history (engaged, §Multi-machine posture)"
  - "Close the Loop — the two declined doors carry named triggers whose count is computed at report-write time (a required artifact, not a remembered count); the deferral ACTs carry a review dueBy (engaged, §3.3, §8)"
  - "Distrust Temporary Success — the claude-family reviewer must NEVER launder the cross-model flag; aggregate/baseline/write-tag all filter on typed crossFamily and REFUSE a claude flag in the cross-model field; no silent opus fallback; no silent harness-door swap (engaged, §5, §1.4)"
---

# Reviewer-Door Rewiring — strongest model via a clean door per provider

## Problem statement

INSTAR-Bench v2 exposed a **door penalty**: the identical model scores materially worse when reached *through the Claude Code coding-harness door* than through a clean path — Opus-4.8-via-Claude-Code **81.7%** vs clean-API **99.1%** on the same prompts, a **17.4-point penalty** (docs/LLM-ROUTING-REGISTRY.md, hard rule 1: "NEVER route bounded gate/sentinel work through opus×claude-code-CLI"). The door you walk a model through is part of the routing decision, and today the spec-converge review bench — the highest-stakes LLM judgment surface in Instar, the thing that gates every instar-source change — takes whatever doors history left it:

- The **external cross-model reviewers** are hardcoded in `src/core/crossModelReviewer.ts`: codex-cli → `gpt-5.5` (subscription OAuth door), gemini-cli → tier-resolved (`gemini-3.1-pro-preview` since PR #1364) via the free OAuth CLI door. There is **no Anthropic reviewer at all** — the strongest available model (Fable 5) never reads a spec through a cleaner door.
- The **six internal reviewers** are Claude subagents inside the authoring session — the coding-harness door, on whatever model the session runs.
- `sessions.componentFrameworks` does **not** reach any of these (they bypass the router with hardcoded `buildIntelligenceProvider({framework})` calls), so no config-only fix exists today.

The operator-approved goal (topic 29723, Task 2a): route the spec-converge reviewers onto the **strongest model via a cleaner door per provider** — Fable 5 via a cleaner Claude path, gpt-5.5, gemini-3.1-pro-preview — reversibly, behind the existing registry constants, dev-gated.

This spec resolves the design questions that goal raises and defines the (small) build. **The round-1 convergence review found that the first draft's "reuse as-is / identical shape" framing was under-specified at the code seam** — it would have silently substituted opus for Fable, thrown instead of degraded on codex-only agents, left the "clean door" un-hardened against prompt injection, and left the §5 anti-laundering guarantees as prose. Those are all resolved below; the design (which providers, which doors) is unchanged.

## Background — what already exists (and what this spec must not re-invent)

| Artifact | What it is | This spec's relationship |
|---|---|---|
| `SUPPORTED_REVIEWER_FRAMEWORKS` (`crossModelReviewer.ts` ~L557) | The extensible reviewer-family registry (codex, gemini). Order = preference order for the back-compat single-reviewer path. | **Extended** with one new entry (the Anthropic cleaner-door family), **appended LAST** (its position is inert for preference selection — §5.3 filters selection on `crossFamily: true`), dev-gated. |
| `TRUSTED_REVIEWER_FRAMEWORKS` (~L572) | The egress allowlist: first-party OAuth CLI adapters only. Full spec text is handed to reviewers, so custom/base-URL endpoints (pi-cli) are banned. | **Extended** with `claude-code` (first-party, fits the invariant). **CRITICAL COUPLING:** this constant is *also* today the filter inside `wasNonClaudeFrameworkActiveWithin` — extending it here MUST land atomically with the baseline re-key (§5.4), or the trusted extension silently poisons the externals-mandatory baseline. |
| `ClaudeCliIntelligenceProvider` (`src/core/ClaudeCliIntelligenceProvider.ts`) | The existing claude door: `claude -p --model <m> --max-turns 1 --setting-sources user --output-format json`, project/local CLAUDE.md excluded, usage-attributed. **NOT hardened** the way `CodexCliIntelligenceProvider` is: no tool/MCP disablement, prompt in argv (ps-visible), full env inheritance. | **Reused, but the review call is hardened at construction (§1.6)** — this is the cleaner Anthropic door once hardened; no new adapter class is built. |
| `CodexCliIntelligenceProvider` | The codex door — runs read-only in an empty scratch dir, prompt via stdin, env allowlist (`buildCodexChildEnv`). The security baseline the claude review call is brought up to. | **Referenced** as the hardening parity target (§1.6). |
| `REVIEW_MODEL_TIER = 'capable'` (~L131) + per-adapter tier resolution | The codex/gemini entries pass the TIER WORD `'capable'` to `provider.evaluate()` and let the provider resolve it. On the claude provider, `'capable'` resolves to **opus** (`models.ts`, `resolveCliFlag`). | **Deliberately NOT copied** for the claude family — it passes the RESOLVED concrete pin (D3, §1.3). The `isConcreteReviewerModel` canary is reused. |
| `scripts/model-registry-freshness.manifest.json` + strict lint | The anti-rot ratchet for concrete model pins. `claude-fable-5` is present today only as a `carried-over-from-allowlist` marker with `pricing: null` — NOT a reviewed row. | **Consumed AND corrected**: inc1 replaces the carried-over marker with a real reviewed row + adds the reviewer-pin regex row (lint is strict — CI-gating). |
| `models.tierEscalation` (`claude-opus-4-8` default / `claude-fable-5` escalated) | The session-level strongest-model path for interactive work. **Ships `enabled:false, dryRun:true` in `DEFAULT_TIER_ESCALATION_CONFIG` — dark AND dry-run even on the dev agent** (it is not itself dev-gated). | **Relied on for the internal six (D7) — with the dark/dry-run default disclosed honestly.** inc3 sets an explicit precondition (enable + `dryRun:false` for the spec-converge trigger on the dev agent) and the dogfood verifies the session model is actually Fable, so "half the goal" cannot silently be a no-op (§4, §1.7). |
| `resolveDevAgentGate` + `DEV_GATED_FEATURES` (`src/core/devGatedFeatures.ts`) + `scripts/lint-dev-agent-dark-gate.js` | The Maturation-Path structural gate: a feature omits `enabled` from config, registers in `DEV_GATED_FEATURES`, and resolves ON-dev/OFF-fleet. | **Used** — the anthropic reviewer is a dev-gated feature (§1.5), not a hardcoded default-false flag. |
| `PostUpdateMigrator.migrateConformanceGateAutoInvoke` (and two sibling spec-converge SKILL.md migrations) | The precedent that spec-converge SKILL.md content changes reach deployed agents via a marker-gated idempotent migration (because `installBuiltinSkills()` never overwrites an existing file). | **Followed** — a new migration ships the SKILL.md edit (§Migration parity). |
| `aggregateRoundOutcomes` + `wasNonClaudeFrameworkActiveWithin` + `detectCrossModelReviewer` (`crossModelReviewer.ts`) | The cross-model disclosure aggregate + the 7-day mandatory-check baseline + the back-compat single-reviewer selection. | **Guarded.** New typed `crossFamily` semantics ensure the claude family can never satisfy, launder, or corrupt any of them (D4, §5). |
| `write-convergence-tag.mjs` | The ONLY writer of the durable convergence frontmatter fields; accepts `--cross-model-review` as an unvalidated string today. | **Hardened** — it REFUSES a `crossFamily:false` value in the `cross-model-review` field, and gains a validated `--clean-door-anthropic-review` writer with its own strip-list entry (§5.2, §5.5). |
| INSTAR-Bench v2 + `docs/LLM-ROUTING-REGISTRY.md` | The measured door-penalty evidence and task-nature taxonomy. | **Applied honestly**: the penalty was measured on the Anthropic coding-harness door on bounded verdicts. It is evidence FOR a cleaner Anthropic door, and NOT evidence against the codex/gemini doors (§2, §3). The registry's stale `enforcement: report` line (the manifest is already `strict`) is corrected in the same PR. |

## Door taxonomy (named, so "clean" stops doing undefined work)

The round-1 externals both flagged that "clean door" was overloaded. This spec uses a three-name taxonomy and never says a bare "clean":

- **`agentic-harness`** — a full coding-harness / interactive session: system-prompt surface, tool loop, project settings/CLAUDE.md, identity context. THIS is the door the 17.4-pt penalty was measured on, and the door the subscription-path interactive pool routes to (§1.4 pins the reviewer OFF it).
- **`print-mode-cli`** — `claude -p --max-turns 1 --setting-sources user` (+ the §1.6 hardening). No agentic loop, no project settings; **but** the CLI print-mode wrapper and user-scope surfaces are still present until hardened. This is the door the claude reviewer family uses. It is *cleaner than the harness door*, NOT the bench-measured clean-API door.
- **`first-party-api`** — the clean-API baseline the 99.1% was measured on. Not used here (no new API key); a direct `print-mode-cli`-vs-`first-party-api` bench is the §8 deferral.

Wherever this spec earlier said "clean door," it now says **"the cleaner `print-mode-cli` door."** The codex door is `print-mode-cli`-class too (read-only scratch dir); the honesty bound is that NO provider's review-shaped door has been bench-measured against its own `first-party-api` baseline yet — that inconsistency is disclosed, and each provider carries a revisit trigger (§8).

## Proposed design

### §1 Anthropic — ADD a cleaner-door Fable 5 reviewer family (the headline change)

A third entry in `SUPPORTED_REVIEWER_FRAMEWORKS`, **appended last**:

```
id: 'claude-code'                    // the IntelligenceFramework id (no union change needed)
crossFamily: false                   // NEW typed field — see §5. Claude reviewing Claude is NOT cross-model.
detect: detectClaudeReviewer(...)    // §1.2
review: via a HARDENED buildIntelligenceProvider call (§1.4, §1.6) — headless, tools/MCP off, concrete-pin model
model: resolveClaudeReviewerModel()  // §1.3 — resolves to the concrete pin 'claude-fable-5', NOT the tier word
```

**§1.1 Why this door is *cleaner* (honesty-bounded).** `ClaudeCliIntelligenceProvider` runs `claude -p` one-shot with `--setting-sources user` (project/local CLAUDE.md and the coding-harness system-prompt surface excluded), `--max-turns 1`, JSON output. That takes it off the `agentic-harness` door the penalty was measured on and onto the `print-mode-cli` door. **It is NOT the bench-measured `first-party-api` door**, and two residual surfaces remain until §1.6 hardening closes them: `--setting-sources user` still loads user-scope CLAUDE.md/hooks/**user-scope MCP servers** (e.g. threadline), and the provider inherits the full parent env + passes the prompt as argv. The claim this spec makes is **"off the measured-penalized `agentic-harness` door and onto a hardened `print-mode-cli` door,"** not "bench-verified 99.1%." A follow-up bench MAY measure the `print-mode-cli` door directly against `first-party-api`, with the real user-scope payload present (tracked deferral, §8).

**§1.2 Detection.** `detectClaudeReviewer(inputs)`: claude binary resolvable (PATH + the same known-location resolution the codex/gemini detectors use) AND a Claude config-home present (`~/.claude` or `CLAUDE_CONFIG_DIR`) AND the feature gate resolves ON for this agent (§1.5) AND `assertClaudeAllowed()` does not forbid claude on this agent. Reason mapping (all NON-throwing):

- no binary → `claude-not-installed`;
- binary present, no config-home → `claude-not-authed`;
- claude forbidden on this agent (codex-only fleet agent, per `claudeForbiddenGuard`) → `claude-forbidden`;
- gate off → `anthropic-reviewer-disabled`.

Injectable inputs for unit tests, mirroring `CrossModelDetectInputs`. Detection NEVER throws; unavailability degrades exactly like codex/gemini. **A machine whose Claude subscription lacks Fable access** surfaces at invocation as a `degraded` result (classifyReviewFailure on the CLI error) — loud, never a silent model substitution (§1.3).

**§1.3 Model resolution — pinned frontier, no silent fallback, no tier word to evaluate().** The claude reviewer family does NOT use `REVIEW_MODEL_TIER` (`'capable'` resolves to **opus** in `models.ts` — deliberately, for everything else). It resolves a **concrete id** and passes THAT concrete id both into the flag string AND into `provider.evaluate({ model })`:

1. Config override `specConverge.reviewers.anthropic.model` if set — must pass `isConcreteReviewerModel` AND match the manifest's claude-door model set (a bare `claude-*` prefix + a not-in-manifest warning in the round log; a concrete-but-weaker id like `claude-haiku-4-5` is accepted only with the logged downgrade warning — the manifest lint covers only the DEFAULT constant, so the override path is canary+prefix-guarded, disclosed as a rot-coverage boundary);
2. else the constant `CLAUDE_REVIEWER_DEFAULT_MODEL = 'claude-fable-5'` (home module: `crossModelReviewer.ts`, beside `REVIEW_MODEL_TIER`).

The pin is registered in `scripts/model-registry-freshness.manifest.json`: inc1 replaces the current `carried-over-from-allowlist` / `pricing:null` marker on `claude-fable-5` with a real reviewed row, and adds a reviewer-pin row keyed on the constant (regex e.g. `CLAUDE_REVIEWER_DEFAULT_MODEL\s*=\s*'([^']+)'`) so the strict lint's drift tooth covers this callsite. There is **no silent auto-fallback to opus**: if Fable is unavailable the round records `degraded` with the real reason (Distrust Temporary Success — a silent fallback would re-create the exact "strongest model isn't actually reviewing" gap this spec closes).

**§1.4 Invocation — the honest shape (diverges from codex/gemini where the code demands it).** The claude entry is NOT a copy-paste of the codex/gemini invocation. Grounded corrections from round 1:

- **Concrete id to `evaluate`, never the tier word.** The codex/gemini entries pass `model: REVIEW_MODEL_TIER` (`'capable'`) and let the provider resolve it; on the claude provider that resolves to opus. The claude entry passes the **resolved concrete pin** as `options.model` to `evaluate()`. The `ReviewerInvokeArgs.providerOverride.model` type is widened from `'fast'|'balanced'|'capable'` to also accept a concrete id string. A unit test asserts the `evaluate` invocation's `model` param **equals the flag's model** and is never a tier word (this pins the honest invariant for all three families — the existing two agree only because their flag-model and evaluated-tier resolve through the same map, which the test now makes non-coincidental).
- **Headless pin — never the interactive pool.** `buildIntelligenceProvider`'s claude-code arm routes through `AnthropicSubscriptionRouter → InteractivePoolIntelligenceProvider` when `options.subscriptionPath` is present — i.e. back onto the `agentic-harness` door. The claude reviewer construction **never passes `subscriptionPath`**, pinning it to the headless `print-mode-cli` provider; a wiring test asserts the constructed provider is the headless one. If the router is ever reached anyway (defence in depth), the round records `degraded: not-clean-door` rather than silently reviewing on the harness door while the flag claims otherwise.
- **Construction is guarded → degrades, never throws.** `buildIntelligenceProvider({framework:'claude-code'})` calls `assertClaudeAllowed()` in the provider constructor, which THROWS on a codex-only agent. The codex/gemini entries construct the provider OUTSIDE the try/catch. The claude entry wraps construction inside the try/catch so a construction throw maps to `degraded` (belt-and-suspenders with the `claude-forbidden` detect reason, §1.2). The registry's "never throws — failures map to degraded" contract is preserved.
- **Resilience machinery, described honestly.** Same `attribution: { component: 'crossModelReviewer' }` (Token-Audit Completeness). The breaker is the **account-global singleton** (`buildIntelligenceProvider` is called with no `breaker` option — per-framework breakers exist only on the IntelligenceRouter path, which reviewers bypass); the spec no longer claims a "per-framework circuit breaker." Degradation classification is by `classifyReviewFailure` string-matching, not the breaker. Because each `cross-model-review.mjs` invocation is a fresh one-shot node process, in-process breaker state does NOT persist across rounds — so this spec adds an explicit **skill-level short-circuit** (§7): after a claude round returns `degraded: rate-limited`, the skill skips the claude family for the remainder of the convergence (no 10 futile Fable-5 re-hits). Same `parseReviewerReply` (reviewer output is UNTRUSTED data folded as findings — never instructions). Timeout: a code-clamped `specConverge.reviewers.timeoutMs` (clamp below, §3.2).
- **Timeout clamp lives in code.** `clampReviewerTimeoutMs(n)` (min 30_000, max 900_000, absent → the current `REVIEW_TIMEOUT_MS` default) is applied inside `crossModelReviewer.ts` for ALL THREE families and (belt-and-suspenders) in the script's arg parse — never a value the invoking agent can push below the floor or above the ceiling. Unit-tested at both boundaries.

**§1.5 Dev-gated (Maturation Path), not a hardcoded default-false flag.** The anthropic reviewer is a `DEV_GATED_FEATURES` entry resolved via `resolveDevAgentGate('specConverge.reviewers.anthropic.enabled')` — config OMITS `enabled`, and the gate resolves **live on a development agent, dark on the fleet**, verified by `scripts/lint-dev-agent-dark-gate.js`. This is the standard's structural pattern; a hardcoded default-false is the exact "#1001 mechanism" that lint exists to catch. The gate is read at the ONE chokepoint the script actually crosses (§Migration parity names the config-resolution path), so `--family claude-code`, `--detect-only`, detect-all, and the activation recorder ALL honor it identically — "dark" and "broken" are not confusable, and a fleet agent cannot spawn Fable reviews with the gate off. (An absent-config fleet agent preserves today's `[codex, gemini]` behavior byte-for-byte.)

**§1.6 Security hardening of the claude review call (before the family is enabled).** The `print-mode-cli` door is brought to codex-door parity for the review call — this is a precondition of inc3, not optional:

- **Tools/MCP off:** the review call passes `--strict-mcp-config` with an empty MCP set and an empty allowed-tools set (`--disallowedTools '*'` or equivalent), so a prompt-injection payload embedded in a spec under review cannot emit a tool call or reach user-scope MCP egress on turn 1. (`--max-turns 1` bounds the loop; it does NOT by itself disable tools.)
- **Neutral scratch cwd:** the call runs in an empty scratch dir (mirroring the codex clean-notepad), not the caller's cwd, so no project surface is inherited via cwd.
- **Prompt off argv, env allowlisted:** the review call transports the prompt via stdin (not `-p <prompt>` argv, which is ps-visible and embedded in `execFile` error messages) and uses an env allowlist (mirroring `buildCodexChildEnv`) so the child does not inherit every server secret (`INSTAR_AUTH_TOKEN`, etc.). If bringing `ClaudeCliIntelligenceProvider` itself to parity is out of scope for inc1, the review call constructs a hardened variant/options — and a unit test asserts the spawn args carry the hardening flags and the env is allowlisted.
- §1.1's honesty bound names the residual user-scope surfaces this closes.

**§1.7 Ships dev-gated + dogfood proof.** The entry registers behind the §1.5 dev gate. The dev-agent dogfood (inc3) verifies BOTH halves of the goal: (a) the external clean-door line `clean-door-anthropic-review: claude-code:claude-fable-5` appears, AND (b) the internal six actually ran on Fable — see §4/§1 (tierEscalation precondition), so the internal half cannot silently be a no-op.

### §2 OpenAI — KEEP gpt-5.5 via the codex-cli subscription door (D1: no OpenRouter adapter)

**Decision: the codex-cli `print-mode-cli` door is clean enough; the OpenRouter adapter is DECLINED.** Rationale, in order of weight:

1. **The penalty is measured on a different door.** The 17.4-pt finding is specific to opus×claude-code-harness (`agentic-harness`). No INSTAR-Bench data shows a penalty on the codex exec door — gpt-5.5-via-codex performed at expected accuracy in v2 (its recorded defect is *latency* (~18.5s), which a spec review doesn't care about). Rewiring a door on the strength of a penalty measured elsewhere would be the bench-dishonesty the routing registry warns against.
2. **OpenRouter structurally violates the egress invariant.** `TRUSTED_REVIEWER_FRAMEWORKS` exists because the FULL spec text leaves the machine; it deliberately admits only first-party OAuth CLI adapters. OpenRouter is a third-party aggregator — spec text would transit OpenRouter's infrastructure en route to OpenAI. Admitting it *deletes the invariant the allowlist encodes*. That is a trust decision above this spec's pay grade (and unneeded, per 1).
3. **Cost + surface.** A new adapter (`IntelligenceFramework` union change, provider, breaker wiring, key management for `metered_openrouter_bench` — referenced by name only) and per-token metered spend, to reach the *same model* (`gpt-5.5`; `gpt-5.6-sol` is preview/partner-gated and NOT on OpenRouter).

**Revisit trigger (named, measurable, artifact-backed — Close the Loop):** IF a future INSTAR-Bench pass measures the codex exec door against the OpenAI `first-party-api` door on review-shaped tasks AND finds a ≥5-point door penalty, this reopens as an operator-approved follow-up. Recorded in `docs/LLM-ROUTING-REGISTRY.md` Risk items (§8.2) so the bench team sees the standing question; the deferral ACT carries a review `dueBy`.

**Availability honesty:** codex-cli is per-machine (binary + `~/.codex/auth.json`). Detection already degrades gracefully where it is missing; nothing here changes OpenAI-side behavior.

### §3 Google — KEEP the gemini-cli OAuth door on gemini-3.1-pro-preview; paid-key adapter DEFERRED behind a measurable trigger (D5/D8)

**§3.1 The model bump already landed (verified in-tree).** PR #1364 (merged, main) moved the gemini `capable` tier to `gemini-3.1-pro-preview` in `src/providers/adapters/gemini-cli/models.ts` (`capable: 'gemini-3.1-pro-preview'`, confirmed this tree), under the strict freshness lint. The gemini reviewer resolves through that tier map, so the "strongest usable Google model" half is **done** — this spec adds no Google model change.

**§3.2 The door's real defect is timeouts, and the first fix is a budget, not an adapter.** The gemini reviewer degraded on timeout in every round of the two most recent convergences. Two confounded causes: (a) the reviewer call's timeout budget vs. 3.1-pro-preview's reasoning-token burn (routing registry hard rule 4: this model burns 5× budgets *thinking*); (b) free-OAuth-door capacity. Cause (a) is addressable for free: `specConverge.reviewers.timeoutMs` (code-clamped 30–900s, §1.4) — a spec review is the least latency-sensitive LLM call in the system; recommended value 600s. **The recommended value is APPLIED, not merely shipped:** inc3 SETS `specConverge.reviewers.timeoutMs: 600000` on the convergence-running (dev) agent, and each convergence report records the **effective reviewer timeout per round** — so D8's precondition ("after the raised timeout is IN EFFECT") is auditable from the same reports D8 is read from. Only if the raised budget still yields chronic timeouts is (b) implicated.

**§3.3 The paid-Gemini-key adapter is DEFERRED, not declined.** Unlike OpenRouter, a paid Google key (`metered_gemini_bench` — name only) reaches a **first-party** endpoint, so it does not break the egress invariant — it is merely a new adapter + metered spend we may not need. **Trigger (named, measurable, artifact-backed):** if, AFTER the raised timeout is in effect, the gemini family records `degraded` on **every round of 3 consecutive convergences**, building the paid-key adapter becomes an operator-approval follow-up. **Counting is a required artifact, not a remembered count (Close the Loop / P18):** the skill computes the consecutive-all-degraded count at report-write time (reading the git-tracked convergence reports — the cross-machine-coherent record, NOT per-machine activation history) and prints one banner line: `gemini: degraded N consecutive convergences — D8 trigger [met / not met]`. No new watcher, no cadenced job (Standard-B stays n/a). The §8.1 deferral ACT carries a review `dueBy` so the queue re-surfaces it regardless.

### §4 The six internal reviewers — stay on the harness, strongest model via session escalation, dark-default disclosed (D7)

The internal reviewers are Task subagents with **tools** — they Read/Grep the repo to verify a spec's claims against code (round-grounded findings like "the claude door resolves 'capable'→opus" come from tool use, not prose). Moving them to a tool-less one-shot door would trade a measured-elsewhere penalty for a certain capability loss. The bench penalty is specific to **bounded verdict-shaped** work (strict-JSON gates); long-form multi-finding tool-grounded review is nature-C work, where the harness door has no measured penalty.

**Decision D7:** the internal six remain harness Task subagents. Their strongest-model path is the **existing** `models.tierEscalation` spec-converge trigger (session → `claude-fable-5`, cascading to subagents). **Honesty (round-1 finding):** `DEFAULT_TIER_ESCALATION_CONFIG` ships `enabled:false, dryRun:true` and is NOT itself dev-gated — so at shipped defaults, on EVERY agent including dev, the internal six run the default tier and the internal half of the operator goal is a no-op. This spec does NOT paper over that:

- inc3 carries an explicit **precondition**: the dev agent runs `models.tierEscalation` with `enabled:true` and `dryRun:false` for the spec-converge trigger, and the dogfood checklist ASSERTS the round log shows `claude-fable-5` as the session model. If that precondition is not met, inc3 does not pass.
- The SKILL.md update adds one disclosure line: *run convergence in an escalation-eligible session; the round log records the session model per round* — disclosure, not a gate (a quota-refused escalation degrades to default tier and must never block convergence).
- The tracked alternative (if the operator declines to enable tierEscalation on dev): scope THIS spec's goal to the external family and record the internal-six strongest-model half as a deferral tied to tierEscalation's own maturation track. Named in §8.4.

### §5 Cross-model semantics guard — the claude family must never launder the flag (typed + code-enforced)

Claude reviewing a Claude-authored spec is a **cleaner-door second read, not a cross-model opinion**. The round-1 adversarial + security reviews found the first draft asserted "unlaunderable/cannot-forge" but left the actual write/invocation chokepoints unguarded. Structural guarantees, now landed AT those chokepoints (typed, unit-tested — never prose):

1. `SupportedReviewerFramework` gains a typed `crossFamily: boolean` (codex `true`, gemini `true`, claude `false`).
2. **`aggregateRoundOutcomes` counts only `crossFamily: true`** toward the spec-level `cross-model-review` flag. A convergence where only the claude family succeeded aggregates to `degraded-all-rounds`/`unavailable` exactly as today. **Unknown/framework-less rows fail LOUD, not silent:** the script's driver-error catch-all today emits a hardcoded `codex-cli` degraded row even for a `--family claude-code` crash — inc1 fixes the catch-all to carry the REQUESTED family (and emit the clean-door flag shape for a claude run), and `aggregateRoundOutcomes` treats any residual missing/unknown-framework `degraded` row as `crossFamily: true` (so a genuine codex crash reads as the louder `degraded-all-rounds`, never the falsely-reassuring `unavailable`, and a claude crash never shapes the cross-model aggregate). Both directions unit-locked.
3. `detectCrossModelReviewer` (the back-compat single-reviewer path) iterates only `crossFamily: true` entries — it can never select claude.
4. **`wasNonClaudeFrameworkActiveWithin` STOPS filtering on `isTrustedReviewerFramework`** (the trusted allowlist, which inc1 extends with `claude-code`) and instead resolves `crossFamily: true` via the registry, with **unknown ids counting as NOT satisfying the baseline**; the activation recorder writes only `crossFamily: true` ids. The trusted-allowlist extension and this re-key **land in the SAME commit** (a regression test asserts a history file containing only `{"claude-code": true}` returns `false`; the inline comment at the filter site is updated to name `crossFamily` as the new invariant). Without this atomicity the trust extension silently poisons the externals-mandatory baseline.
5. **The durable write path refuses laundering.** `write-convergence-tag.mjs` gains a deterministic refusal: any `--cross-model-review` value whose family segment resolves to a `crossFamily:false` registry entry (or is not a known `crossFamily:true` family / non-ran enum) is REJECTED — a driver cannot pass `--cross-model-review "claude-code:claude-fable-5"` into the cross-model field. The claude pass is recorded in a NEW, separate, validated field written by a NEW `--clean-door-anthropic-review` argument (added to the managed-lines strip list so re-stamps are idempotent, not duplicated); that field accepts ONLY `claude-code:<model>` / `degraded` / `not-run`. The `--family claude-code` script path renders its `ReviewerResult.flag` as `clean-door-anthropic-review: …`, never `cross-model-review: …`.
6. **Report-banner rendering rule (anti-perception-laundering).** When the cross-model aggregate is ANY non-ran state (⚠), the `clean-door-anthropic-review` line MUST render *inside/below* the cross-model banner block with fixed text: **"(same-family second read — NOT a cross-model review)"** — so a green-looking Anthropic line can never visually offset the ⚠ the human reads before approving. Added to the report-validation checklist.
7. **`--detect-only` `available` semantics.** `available` is redefined as `crossFamily`-only (does the round have a real external?); a separate `cleanDoorAvailable` field reports the claude family. This keeps the skill's Phase-3 "externals available?" branch honest (a claude-only machine does not read as "externals available").
8. **Synthesis-honesty trace (residual same-family risk).** Fable-5 may author the spec, run the internal six, run the clean-door reviewer, AND synthesize which findings are material. §5 refuses flag laundering but cannot weight synthesis; so the report-validation checklist adds one rule: **every cross-family finding with verdict SERIOUS / MINOR ISSUES must appear in the findings table with an explicit disposition (addressed / rebutted-with-reason)** — a checkable trace that the outside opinions were honored, not a weighting change.

### §6 Signal vs. Authority

Unchanged: every reviewer (internal, external, clean-door) is a **signal** into the convergence synthesis. No pass gains blocking authority; a degraded/unavailable family degrades loudly and convergence proceeds under the existing disclosure rules. The §1.5 dev gate gates *availability of a signal source*, not any authority.

### §7 Cost, bounds, and blast radius

- **Volume bound (honestly, skill-driven convention — not code):** ≤1 claude-family call per round × ≤10 rounds per convergence is a *skill discipline* (SKILL.md hard-caps 10 iterations; the script enforces no per-convergence limit). The structural bounds that ARE code are the host spawn-cap (concurrency) and the timeout clamp (duration). Delta-gating (unchanged body → externals skipped) trims mostly the tail confirmation rounds — during active convergence the body changes almost every round, so the realistic bound is ~10 calls/family/convergence.
- **Spawn-slot occupancy (the real concurrency cost, added in round 1):** families run **sequentially** within a round (the round loop invokes `--family` per family in turn — stated explicitly so the occupancy is bounded to one reviewer slot at a time, not three). Each call holds ONE host spawn-cap slot (default cap 8) for up to the clamp max. Reviewer calls are background-lane (no `lane:'interactive'`), and the `INTERACTIVE_LANE_ALLOWLIST` reserves carve-out waiters for the two operator-facing gates (MessagingToneGate, MessageSentinel) — so a long reviewer hold does not starve the fail-closed safety gates of their reserved slots. The clamp max is 900s but the RECOMMENDED and inc3-applied value is 600s; the spec explicitly accepts "one long-held background slot during a convergence round" as within budget on the dev agent, with the fleet posture deferred to inc4.
- **Spend + shared-account correlation (added in round 1):** Fable 5 rides the subscription/Agent-SDK path via `buildIntelligenceProvider` — no new metered spend — BUT the claude reviewer drains the **same subscription window as the Fable-escalated session driving the convergence** (D7), and it bypasses the EscalationGovernor's cost guards (those apply to spawned sessions, not `.evaluate()` calls). So the failure mode is not just "one degraded round" — the reviewer calls can accelerate the driver's own quota wall. Mitigations: (a) the §1.4 skill-level short-circuit stops re-hitting a walled account; (b) quota pressure is observable via `GET /subscription-pool`; (c) inc3's dogfood soak **measures real per-convergence Fable spend** before any fleet decision (inc4). The spec does not add a pre-call quota gate (kept simple); it discloses the correlation and measures it.
- **Round wall-clock envelope:** families sequential → per-round added latency ≈ sum of the families' actual call times (not max); worst case bounded by (families × clamped timeout). Across a 10-round convergence this can add meaningfully to a time-boxed autonomous run — stated so a convergence that previously fit a time-box is planned with the larger envelope. A degraded/timed-out family does not extend beyond its clamp.
- **Breaker:** account-global singleton, per-process-ephemeral (§1.4). A breaker-open round records `degraded: rate-limited`; the skill-level short-circuit is what provides cross-round backoff (the in-process breaker cannot, since each round is a fresh process).

### Decision points touched

- `SUPPORTED_REVIEWER_FRAMEWORKS` — one new entry, **appended last**, dev-gated; codex remains preference leader; ordering among existing entries unchanged; the new `crossFamily` field added to all entries (codex/gemini `true`).
- `TRUSTED_REVIEWER_FRAMEWORKS` — gains `'claude-code'`, **atomically with the §5.4 baseline re-key**. pi-cli remains banned; the first-party-only invariant is restated in the constant's doc comment as the *reason OpenRouter is not here*.
- `wasNonClaudeFrameworkActiveWithin` / `detectCrossModelReviewer` / `aggregateRoundOutcomes` — gain `crossFamily` filtering + the unknown-row fail-loud rule (behavior for existing families byte-identical; unit-locked).
- `clampReviewerTimeoutMs` — new, applied to all three families in `crossModelReviewer.ts` + the script arg parse.
- `cross-model-review.mjs` — reads/honors the §1.5 gate at the invocation chokepoint; catch-all carries the requested family; `--detect-only` emits `crossFamily`-only `available` + `cleanDoorAvailable`.
- `write-convergence-tag.mjs` — cross-model-review refusal of `crossFamily:false` values; new validated `--clean-door-anthropic-review` writer + strip-list entry.
- `models.ts` — `ReviewerInvokeArgs.providerOverride.model` widened to accept a concrete id (no runtime behavior change for existing tier-word callers).
- `scripts/model-registry-freshness.manifest.json` — real reviewed row for `claude-fable-5` + reviewer-pin regex row.
- `src/core/devGatedFeatures.ts` — new `DEV_GATED_FEATURES` entry.
- `src/core/PostUpdateMigrator.ts` — new SKILL.md migration.
- No block/allow gate, no HTTP route, no scheduler job, no watcher is introduced or modified.

### Multi-machine posture

Default posture is `unified`; each machine-local surface below carries a closed-taxonomy justification.

- **Reviewer availability (which families detect on this machine)** — machine-local BY DESIGN.
  machine-local-justification: physical-credential-locality — each family's door is a per-disk CLI login (claude OAuth config-home, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`); reachability cannot replicate without replicating credentials, which is forbidden.
- **`state/framework-activation-history.jsonl`** — existing surface, unchanged; machine-local for the same reason (it records THIS machine's detections).
  machine-local-justification: physical-credential-locality — it is a record of per-disk login availability.
- **Internal-six model strength (D7)** — consumed per-machine via `models.tierEscalation` and its EscalationGovernor cost guards (quota headroom / per-account caps are per-machine, credential-adjacent). A convergence landing on a quota-blocked machine runs the internal six on the default tier; this is disclosed per round via the SKILL.md session-model line (honest at runtime).
  machine-local-justification: physical-credential-locality — escalation eligibility is gated on the per-disk account's live quota.
- **D8 / D1 revisit-trigger evaluation** — declared `unified`: reads the **git-tracked convergence reports** (unified via the repo), NOT per-machine activation history — so "3 consecutive all-degraded convergences" is coherent regardless of which machine ran each convergence (round-1 integration finding: activation-history-based counting would be split-brained).
- **Config (`specConverge.reviewers.*`)** — declared `unified` (ordinary per-agent config in `.instar/config.json`; rides the existing config replication posture; no new state surface). The config-RESOLUTION path is named in §Migration parity (the worktree-vs-live-config hazard is closed by resolving against the live agent home, not the script's cwd).
- Convergence itself runs on one machine per run; no cross-machine notice, URL, or durable-topic surface is added.

### Standard-B note (Self-Heal Before Notify) — explicitly n/a (contested and upheld in round 1)

This spec adds **no monitor, watcher, or recurring notice source**. The §3.3 / §2 triggers are evaluated by a human (or the convergence-running agent) reading git-tracked convergence reports at the next convergence — the count is a required report artifact (§3.3), not a cadenced job, attention-queue item, or escalation path. Degraded reviewer rounds surface where they always have: in the per-spec convergence report banner. No self-heal gate is owed.

### Security considerations

- **Egress:** spec text already flows to Anthropic (authoring session), OpenAI (codex), Google (gemini). The claude family adds **zero new egress destinations**. OpenRouter is declined partly on this axis (§2.2).
- **Prompt-injection surface (round-1 finding, closed by §1.6):** the `print-mode-cli` door is hardened for the review call — tools/MCP disabled, neutral scratch cwd, prompt off argv, env allowlisted — so a spec under review cannot emit a tool call or reach user-scope MCP egress, and the ~60KB prompt is not ps-visible / not embedded in error text, and the child does not inherit server secrets. This brings the claude door to codex-door parity; a unit test asserts the hardening flags + env allowlist are present.
- **No silent harness-door swap (round-1 finding, closed by §1.4):** the reviewer provider is pinned headless (never `subscriptionPath`); a router-routed round records `degraded: not-clean-door` rather than reviewing on the `agentic-harness` door while the flag claims otherwise.
- **Trust allowlist:** extended only with a first-party OAuth CLI — the invariant ("no custom/base-URL endpoint may receive spec text") is preserved; extension is atomic with the baseline re-key (§5.4) so it cannot invert the externals-mandatory guarantee.
- **Flag authenticity (scoped honestly):** §5.5's guarantees are that the SCRIPT PATH cannot mis-render or launder the field AND the tag writer REFUSES a `crossFamily:false` value in the cross-model field. A hand-edited frontmatter line remains possible (the same caller-trust model as every other convergence tag); the claim is scoped to the write path, not "cannot forge by hand."
- **Config model override:** validated by `isConcreteReviewerModel` + a manifest/`claude-*`-prefix check with a logged downgrade warning; the rot-coverage boundary (override outside the manifest lint) is disclosed (§1.3).
- **Secrets:** no new keys, no key material in config (the model override is a model id string). Vault names (`metered_gemini_bench`, `metered_openrouter_bench`) appear by NAME only in deferral rationale.
- **Config-flip abuse:** the dev gate adds a signal source; it cannot alter the cross-model flag (§5) or any gate. A mid-convergence flip is honored at the invocation chokepoint (§1.5) and recorded (`clean-door-anthropic-review: not-run` for later rounds) in the iteration log.

### Testing (three tiers — Testing Integrity Standard)

- **Unit** (`tests/unit/`):
  - detection: injectable inputs (binary present/absent, config-home present/absent, claude-forbidden, gate off) → the four reasons in §1.2, never throws;
  - model resolution: default concrete pin, config override (accepted + downgrade-warned), canary rejection of tier words;
  - **evaluate-arg honesty (the headline test):** the `evaluate` invocation's `model` param equals the flag's model and is a concrete id, never a tier word — for all three families;
  - **headless pin:** the constructed provider is the headless one; `subscriptionPath` is never passed; a simulated router route records `degraded: not-clean-door`;
  - **construction guard:** a thrown `assertClaudeAllowed` maps to `degraded`, not an escape;
  - **hardening:** spawn args carry tools/MCP-off flags, neutral cwd, stdin transport, allowlisted env;
  - `crossFamily` filtering in `aggregateRoundOutcomes` (claude-only success does NOT produce a clean cross-model flag; a `--family claude-code` crash does NOT become a codex row; an unknown-framework degraded row reads as `degraded-all-rounds` not `unavailable`);
  - `detectCrossModelReviewer` never selects claude;
  - **baseline regression:** a history file of only `{"claude-code": true}` → `wasNonClaudeFrameworkActiveWithin` returns `false` (the anti-poisoning lock);
  - `clampReviewerTimeoutMs` at both boundaries;
  - dev-gate default: absent config on a fleet agent → registry accessors return `[codex, gemini]` exactly; on a dev agent → the claude family is available.
- **Integration** (`tests/integration/`):
  - `cross-model-review.mjs --family claude-code` with a stubbed provider — accepted by the trusted allowlist, honors the gate (unavailable when off), emits `clean-door-anthropic-review` flag shape;
  - `--detect-only` output carries the new family + `cleanDoorAvailable` only when the gate is on; `available` is crossFamily-only;
  - `write-convergence-tag.mjs` REFUSES `--cross-model-review claude-code:...` and ACCEPTS `--clean-door-anthropic-review claude-code:claude-fable-5` (idempotent re-stamp);
  - **config-file drive (the #1296-class guard):** enablement is driven through a real config FILE resolved from the live agent home, not an in-memory object.
- **E2E / liveness:** the dogfood proof — the first dev-agent convergence after the flip runs three families; the convergence report shows the `clean-door-anthropic-review` line AND the round log shows `claude-fable-5` as the session model (the internal-six half). Recorded in the inc3 checklist; the report artifact is the "feature is alive" evidence (no HTTP route to probe).
- **Wiring integrity:** the registry entry's provider construction asserted non-null AND headless under an enabled config in unit tests.

### Migration parity

- **New config block `specConverge.reviewers`** — absent-safe: unknown top-level config blocks survive `loadConfig` (spread), and the dev gate omits `enabled` from defaults, so no `migrateConfig` entry is needed for absence. **The config-resolution chokepoint is named (round-1 #1296-class finding):** the registry accessor takes an injected `{ anthropicEnabled, timeoutMs }` resolved by the script from the **live agent `.instar/config.json` (agent home), NOT the script's cwd** — because the skill frequently runs inside a worktree whose tracked `.instar/config.json` diverges from the live agent config. The script threads this via an explicit `--config-dir <agent .instar>` (or documented equivalent); a wiring test drives enablement through the real file.
- **SKILL.md content change REQUIRES a PostUpdateMigrator migration (round-1 finding — the first draft's claim that it did not was false).** spec-converge SKILL.md is an installed built-in skill; `installBuiltinSkills()` never overwrites existing files; three precedent migrations (`migrateConformanceGateAutoInvoke` + two siblings) exist for exactly this. inc1 (or the increment landing the prose) ships a marker-gated idempotent migration following that pattern (marker e.g. `clean-door-anthropic-review`, fingerprint `# /spec-converge`), so deployed agents' installed copy gets the D7 disclosure line, the new config-surface documentation, and the `clean-door-anthropic-review` semantics.
- **Agent Awareness:** the reviewer family is repo-scoped instar-dev tooling whose only consumer is `/spec-converge` — an end-user agent cannot run a convergence, so NO `generateClaudeMd()` template entry is added (that would be awareness of a capability the reading agent lacks — bloat, not awareness, per P5/L1). The SKILL.md update IS the awareness surface, and it must document `specConverge.reviewers.anthropic.{enabled,model}`, `timeoutMs`, and the `clean-door-anthropic-review` field — not only the D7 line.
- The freshness-manifest edit (real reviewed row + reviewer-pin row) and the routing-registry doc correction (`enforcement: report` → the manifest is already `strict`) ride the same PR (lint is strict; CI enforces coherence).

## Frontloaded Decisions

- **D1 (OpenAI door):** gpt-5.5 stays on the codex-cli subscription door. OpenRouter adapter DECLINED (penalty measured elsewhere; egress invariant; cost/surface). Revisit: a measured ≥5-pt codex-door penalty vs OpenAI `first-party-api` on review-shaped bench tasks (artifact-backed, §2).
- **D2 (Anthropic door):** add the `claude-code` reviewer family via `ClaudeCliIntelligenceProvider` (hardened for the review call, §1.6) — no new adapter class, no union change; appended LAST in the registry (inert for selection). Dev-gated via `resolveDevAgentGate` (live-on-dev / dark-fleet), NOT a hardcoded default-false flag.
- **D3 (Anthropic model):** default concrete pin `CLAUDE_REVIEWER_DEFAULT_MODEL = 'claude-fable-5'` (constant + real freshness-manifest reviewed row + reviewer-pin regex row), config-overridable (canary + manifest/prefix check + downgrade warning), **the resolved concrete id is passed to `evaluate()` — never the tier word** (no silent opus substitution), **no silent fallback** — unavailability degrades loudly.
- **D4 (cross-model honesty):** typed `crossFamily: false` for the claude family; aggregate flag, single-reviewer path, AND the 7-day mandatory-check baseline all filter on `crossFamily: true` (baseline re-key lands atomically with the trusted-allowlist extension); unknown-framework rows fail loud; the tag writer REFUSES a claude flag in the cross-model field; the claude pass gets its own validated `clean-door-anthropic-review` field with a fixed same-family banner caption.
- **D5 (Google door):** stay on gemini-cli OAuth; model bump to `gemini-3.1-pro-preview` already landed (PR #1364, verified); no Google model change here.
- **D6 (Google timeout-first):** `specConverge.reviewers.timeoutMs`, **code-clamped 30–900s** (absent = current defaults); recommended 600s. inc3 SETS 600000 on the convergence-running agent (shipping ≠ applying); each report records the effective per-round timeout. Cheap fix tried BEFORE any paid door.
- **D7 (internal six):** remain harness Task subagents (tool grounding is load-bearing; penalty is measured on bounded verdicts). Strongest-model path = `models.tierEscalation` spec-converge trigger — whose shipped default is `enabled:false, dryRun:true` even on dev (disclosed); inc3 preconditions enabling it + `dryRun:false` on the dev agent and the dogfood asserts a Fable session model, else the internal half is scoped out as a tracked deferral (§8.4).
- **D8 (paid-Gemini-key adapter):** DEFERRED behind the measurable trigger (3 consecutive convergences all-round gemini degraded, AFTER the raised timeout is in effect, counted from git-tracked reports at report-write time) + operator approval. First-party endpoint, so trust-compatible when justified.
- **D9 (claude detection semantics):** binary + config-home + gate-on + not-claude-forbidden = available; auth/entitlement failures surface at invocation as `degraded`; construction throw is caught → `degraded`.
- **D10 (reversibility):** every change is behind the dev gate or byte-identical-by-default code paths; rollback = disable the gate (or revert the docs/constants/migration PR). No data migration, no durable state, no external side-effects.
- **D11 (security hardening is a precondition):** the §1.6 hardening (tools/MCP off, neutral cwd, stdin prompt, env allowlist) MUST be in place before the family is enabled (inc3) — the door is not "clean" until it is hardened to codex-door parity.
- **D12 (config-resolution source):** the gate + timeout are resolved from the LIVE agent `.instar/config.json` (agent home), never the script's cwd, to survive the worktree-vs-live-config divergence.

## Cheap-to-change-after tags

- `timeoutMs` default/recommended values (within the code-enforced 30–900s clamp) — **cheap-to-change-after** (a config knob read per invocation; no persistence, no external interface, no side-effect). CONTESTED and cleared: reversibility holds; the clamp itself is code (structure), only the value is the knob.
- The §3.3 / §2 trigger thresholds (3 consecutive convergences / ≥5-pt penalty) — **cheap-to-change-after** (documented human-decision rules; changing them edits this spec's prose + the deferral record; no code/interface). CONTESTED and cleared: no non-cheap-taxonomy hit.
- The `clean-door-anthropic-review` field NAME — **cheap-to-change-after ONLY while dev-gated**. The field lands in committed convergence reports/frontmatter at inc3 (durable git artifacts), so its cheapness rests entirely on the §5 no-consumer guarantee: nothing keys on it (it cannot satisfy the 7-day baseline, cannot forge `cross-model-review`, no gate reads it), so a rename before fleet exposure is a grep-scale edit over dev-only artifacts. The cheap window effectively ENDS at inc3 dogfood. CONTESTED and cleared with that caveat.

## Rollout increments

- **inc1 — the family, dev-gated (code + tests), landed as ONE coherent commit set.** `detectClaudeReviewer` (+ the four reasons), the registry entry with typed `crossFamily` (appended last), concrete-pin model resolution + `evaluate`-arg honesty, headless pin, construction guard, §1.6 hardening, the trusted-allowlist extension **atomic with** the §5.4 baseline re-key + anti-poisoning regression test, `clampReviewerTimeoutMs`, the catch-all/unknown-row fail-loud fixes, `--detect-only` crossFamily-only `available`, the `write-convergence-tag.mjs` refusal + validated `--clean-door-anthropic-review` writer, the `providerOverride.model` type widening, the freshness-manifest reviewed+pin rows, the `DEV_GATED_FEATURES` entry, the SKILL.md migration, and the routing-registry doc correction. Unit + integration tests. **Fleet behavior byte-identical** (gate dark on fleet).
- **inc2 — timeout knob threaded.** `specConverge.reviewers.timeoutMs` (code-clamped) applied to all three families' invocations (absent = today's defaults). Fleet behavior byte-identical when absent.
- **inc3 — dev-agent flip + dogfood (this increment ENDS the build run).** Verify the §1.5 gate resolves live on the dev agent; SET `specConverge.reviewers.timeoutMs: 600000`; ensure the §1.6 hardening is in place (D11); enable `models.tierEscalation` + `dryRun:false` for the spec-converge trigger (D7 precondition). The next real convergence runs three families; verify the report carries `clean-door-anthropic-review: claude-code:claude-fable-5`, the round log shows `claude-fable-5` as the session model (internal-six half), the cross-model flag semantics are untouched, and the SKILL.md session-model disclosure line is recorded. **The build run ends here** (at the flip + first dogfood convergence); the ≥2-convergence soak is a post-run observation window whose evidence feeds inc4.
- **inc4 — operator decision point (out of the build run's scope; genuine operator gate).** Present dogfood + soak evidence (including measured per-convergence Fable spend, §7); operator chooses fleet posture (stay dev-only is a valid steady state — this is instar-dev tooling). The deferrals (§8) remain tracked regardless.

## §8 Tracked deferrals (Close the Loop)

1. **Paid-Gemini-key reviewer door** — deferred behind D8's trigger; registered as an evolution action at inc1 merge with a review `dueBy` (so the action queue re-surfaces it); trigger count computed at report-write time from git-tracked reports.
2. **OpenRouter door for OpenAI** — declined with D1's revisit trigger; recorded in `docs/LLM-ROUTING-REGISTRY.md` Risk items so the bench team sees the standing question; ACT with `dueBy`.
3. **Bench the `print-mode-cli` door directly vs `first-party-api`** (§1.1 / §2 honesty bound) — a candidate INSTAR-Bench v3 task, measured with the real user-scope payload present; registered alongside 1.
4. **Internal-six strongest-model half (conditional)** — IF the operator declines to enable `models.tierEscalation` (`dryRun:false`) on the dev agent at inc3, the internal-six clean-model half is scoped out of THIS spec and tracked against tierEscalation's own maturation track (D7); the external clean-door family still ships.
5. **SelfHealGate runtime application** — n/a here (no watcher); noted only to be explicit that this spec does not claim it.

## Open questions

*(none — all decisions frontloaded above)*
