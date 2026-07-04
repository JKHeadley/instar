---
title: "Reviewer-Door Rewiring — strongest model via a clean door per provider for the spec-converge reviewers"
slug: "reviewer-door-rewiring"
author: "echo"
status: "draft"
parent-principle: "Structure beats Willpower"
extends:
  - "src/core/crossModelReviewer.ts (SUPPORTED_REVIEWER_FRAMEWORKS / TRUSTED_REVIEWER_FRAMEWORKS registry)"
  - "src/core/ClaudeCliIntelligenceProvider.ts (the existing clean claude -p door)"
  - "docs/LLM-ROUTING-REGISTRY.md (door-penalty findings, task-nature taxonomy)"
  - "scripts/model-registry-freshness.manifest.json + scripts/lint-model-registry-freshness.mjs (Keep the Doorway/Model Map Current)"
  - "docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md (the doorway registry this spec consumes)"
eli16-overview: "docs/specs/REVIEWER-DOOR-REWIRING-SPEC.eli16.md"
lessons-engaged:
  - "Structure beats Willpower — reviewer doors live in a typed registry + config gate, not in prose about which model to use (parent principle)"
  - "Signal vs. Authority — reviewer passes are signals into convergence; nothing here gains blocking authority (engaged, §6)"
  - "Keep the Doorway/Model Map Current — every concrete model pin this spec adds is registered in the freshness manifest with lastReviewedAt, under the strict lint (engaged, §1.3)"
  - "Intelligent Prompts / bench honesty — the door penalty is applied where it was MEASURED (Anthropic coding-harness door, bounded verdicts), not smeared over unmeasured doors (engaged, §2, §4)"
  - "Token-Audit Completeness — the new reviewer family calls ride buildIntelligenceProvider with attribution.component so every token is attributed (engaged, §1.4)"
  - "Bounded Blast Radius — reviewer calls ride the host spawn-cap funnel + per-framework circuit breaker; one call per family per round, rounds hard-capped at 10 (engaged, §7)"
  - "Cross-Machine Coherence / P21 — reviewer availability is per-disk CLI logins; declared machine-local with the closed-taxonomy justification (engaged, §Multi-machine posture)"
  - "Close the Loop — the two declined doors (OpenRouter, paid-Gemini-key) carry named, measurable revisit triggers registered as tracked deferrals, not silent drops (engaged, §8)"
  - "Distrust Temporary Success — the claude-family reviewer must NEVER launder the cross-model flag; aggregate semantics are typed (crossFamily) and unit-tested, not remembered (engaged, §5)"
---

# Reviewer-Door Rewiring — strongest model via a clean door per provider

## Problem statement

INSTAR-Bench v2 exposed a **door penalty**: the identical model scores materially worse when reached *through the Claude Code coding-harness door* than through a clean path — Opus-4.8-via-Claude-Code **81.7%** vs clean-API **99.1%** on the same prompts, a **17.4-point penalty** (docs/LLM-ROUTING-REGISTRY.md, hard rule 1: "NEVER route bounded gate/sentinel work through opus×claude-code-CLI"). The door you walk a model through is part of the routing decision, and today the spec-converge review bench — the highest-stakes LLM judgment surface in Instar, the thing that gates every instar-source change — takes whatever doors history left it:

- The **external cross-model reviewers** are hardcoded in `src/core/crossModelReviewer.ts`: codex-cli → `gpt-5.5` (subscription OAuth door), gemini-cli → tier-resolved (`gemini-3.1-pro-preview` since PR #1364) via the free OAuth CLI door. There is **no Anthropic external reviewer at all** — the strongest available model (Fable 5) never reads a spec through a clean door.
- The **six internal reviewers** are Claude subagents inside the authoring session — the coding-harness door, on whatever model the session runs.
- `sessions.componentFrameworks` does **not** reach any of these (they bypass the router with hardcoded `buildIntelligenceProvider({framework})` calls), so no config-only fix exists today.

The operator-approved goal (topic 29723, Task 2a): route the spec-converge reviewers onto the **strongest model via a CLEAN door per provider** — Fable 5 via a clean Claude path, gpt-5.5, gemini-3.1-pro-preview — reversibly, behind the existing registry constants, dark by default.

This spec resolves the four design questions that goal raises and defines the (small) build.

## Background — what already exists (and what this spec must not re-invent)

| Artifact | What it is | This spec's relationship |
|---|---|---|
| `SUPPORTED_REVIEWER_FRAMEWORKS` (`crossModelReviewer.ts` ~L557) | The extensible external-reviewer registry (codex, gemini). Order = preference order. | **Extended** with one new entry (the Anthropic clean-door family), config-gated dark. |
| `TRUSTED_REVIEWER_FRAMEWORKS` (~L572) | The egress allowlist: first-party OAuth CLI adapters only. Full spec text is handed to reviewers, so custom/base-URL endpoints (pi-cli) are banned. | **Extended** with `claude-code` (first-party, fits the invariant). The invariant itself is *load-bearing for DQ1* — it is the structural reason OpenRouter is declined. |
| `ClaudeCliIntelligenceProvider` (`src/core/ClaudeCliIntelligenceProvider.ts`) | The existing clean Claude door: `claude -p --model <m> --max-turns 1 --setting-sources user --output-format json`, project/local CLAUDE.md excluded, usage-attributed. | **Reused as-is.** This IS the clean Anthropic door; no new adapter is built. |
| `REVIEW_MODEL_TIER = 'capable'` (~L131) + per-adapter `TIER_TO_MODEL` maps | Dynamic model resolution per framework; the `isConcreteReviewerModel` canary fails loud on a tier word falling through. | **Reused.** The claude family gets its own resolution (D3) with the same canary. |
| `scripts/model-registry-freshness.manifest.json` + strict lint | The anti-rot ratchet for concrete model pins. `claude-fable-5` is already a registered frontier id on the claude doors. | **Consumed.** The new pin is added to the manifest's reviewed layer in the same change (lint is strict — CI-gating). |
| `models.tierEscalation` (`claude-opus-4-8` default / `claude-fable-5` escalated, spec-converge + build triggers) | The session-level strongest-model path for interactive work. | **Relied on** for the internal six (D7): a spec-converge session escalates to Fable 5 — the internal reviewers inherit it. |
| `aggregateRoundOutcomes` + `wasNonClaudeFrameworkActiveWithin` (`crossModelReviewer.ts`) | The cross-model disclosure aggregate + the 7-day mandatory-check baseline. | **Guarded.** New typed `crossFamily` semantics ensure the claude family can never satisfy or launder either (D4, §5). |
| INSTAR-Bench v2 + `docs/LLM-ROUTING-REGISTRY.md` | The measured door-penalty evidence and task-nature taxonomy. | **Applied honestly**: the penalty was measured on the Anthropic coding-harness door on bounded verdicts. It is evidence FOR the clean Anthropic door, and NOT evidence against the codex/gemini doors (§2, §3). |

## Proposed design

### §1 Anthropic — ADD a clean-door Fable 5 reviewer family (the headline change)

A third entry in `SUPPORTED_REVIEWER_FRAMEWORKS`:

```
id: 'claude-code'                    // the IntelligenceFramework id (no union change needed)
crossFamily: false                   // NEW field — see §5. Claude reviewing Claude is NOT cross-model.
detect: detectClaudeReviewer(...)    // §1.2
review: via buildIntelligenceProvider({ framework: 'claude-code' })  // resolves ClaudeCliIntelligenceProvider
model: resolveClaudeReviewerModel()  // §1.3 — 'claude-fable-5' by default, config-overridable
```

**§1.1 Why this door is clean.** `ClaudeCliIntelligenceProvider` runs `claude -p` one-shot with `--setting-sources user` (project/local CLAUDE.md and the coding-harness system-prompt surface excluded), `--max-turns 1`, JSON output. This is the same *shape* of door as the bench's clean-API baseline: no agentic harness context, no tool loop, no identity contamination. It is categorically distinct from the coding-harness door the penalty was measured on. (Honesty bound: the bench measured clean-**API**, not clean-`claude -p`; `claude -p` still carries the CLI's print-mode wrapper. The claim this spec makes is "off the measured-penalized door and onto the cleanest first-party door we have," not "bench-verified 99.1% door." A follow-up bench task MAY measure the `claude -p` door directly — tracked deferral, §8.)

**§1.2 Detection.** `detectClaudeReviewer(inputs)`: claude binary resolvable (PATH + the same known-location resolution pattern the codex/gemini detectors use) AND a Claude config-home present (`~/.claude` or `CLAUDE_CONFIG_DIR`). Injectable inputs for unit tests, mirroring `CrossModelDetectInputs`. New unavailable-reasons: `claude-not-installed`, `claude-not-authed`. Detection NEVER throws; unavailability degrades exactly like codex/gemini. **A machine whose Claude subscription lacks Fable access** surfaces at invocation as a `degraded` result (classifyReviewFailure on the CLI error) — loud, never a silent model substitution (§1.3).

**§1.3 Model resolution — pinned frontier, no silent fallback.** The claude reviewer family does NOT use `REVIEW_MODEL_TIER` (`'capable'` resolves to opus in `src/core/models.ts` — deliberately, for everything else). It resolves:

1. Config override `specConverge.reviewers.anthropic.model` if set (must pass `isConcreteReviewerModel`);
2. else the constant `CLAUDE_REVIEWER_DEFAULT_MODEL = 'claude-fable-5'`.

The pin is a concrete id, so it is registered in `scripts/model-registry-freshness.manifest.json` (it is already present as `ultra-anthropic` frontier on the claude doors; the change adds the reviewer-pin row/`$comment` linkage so the strict lint's drift tooth covers this callsite) — per the "Keep the Doorway/Model Map Current" standard, a rotting `claude-fable-5` fails CI rather than silently reviewing on a superseded model. There is **no silent auto-fallback to opus**: if Fable is unavailable on this machine/account the round records `degraded` with the real reason, and the operator may set the config override. (A silent fallback would quietly re-create the exact "strongest model isn't actually reviewing" gap this spec closes — Distrust Temporary Success.)

**§1.4 Invocation.** Identical shape to the codex/gemini entries: same fail-loud model canary, same `buildIntelligenceProvider` factory (spawn-cap funnel + per-framework circuit breaker + subscription-path routing), same `attribution: { component: 'crossModelReviewer' }` (Token-Audit Completeness; the framework/model dimensions in `/metrics/features` distinguish the families), same `classifyReviewFailure` → `degraded` semantics, same `parseReviewerReply` (reviewer output is UNTRUSTED data folded as findings — never instructions). Timeout: `specConverge.reviewers.timeoutMs` (§3.2) — reviewer calls are latency-tolerant.

**§1.5 Ships dark.** The entry is registered but the registry accessors filter it out unless `specConverge.reviewers.anthropic.enabled === true` (default `false` — absent config preserves today's `[codex, gemini]` exactly, byte-for-byte behavior). Live on the development agent first (dogfood: this very skill's next convergence runs three families), dark on the fleet until the operator flips it.

### §2 OpenAI — KEEP gpt-5.5 via the codex-cli subscription door (DQ1 resolved: no OpenRouter adapter)

**Decision: the codex-cli door is already clean enough; the OpenRouter adapter is DECLINED.** Rationale, in order of weight:

1. **The penalty is measured on a different door.** The 17.4-pt finding is specific to opus×claude-code-harness. No INSTAR-Bench data shows a penalty on the codex exec door — gpt-5.5-via-codex performed at expected accuracy in v2 (its recorded defect is *latency* (~18.5s), which a spec review doesn't care about). Rewiring a door on the strength of a penalty measured elsewhere would be exactly the bench-dishonesty the routing registry warns against.
2. **OpenRouter structurally violates the egress invariant.** `TRUSTED_REVIEWER_FRAMEWORKS` exists because the FULL spec text leaves the machine; it deliberately admits only first-party OAuth CLI adapters. OpenRouter is a third-party aggregator — spec text would transit OpenRouter's infrastructure en route to OpenAI. Admitting it doesn't extend the allowlist, it *deletes the invariant the allowlist encodes*. That is a trust decision above this spec's pay grade (and unneeded, per 1).
3. **Cost + surface.** A new adapter (`IntelligenceFramework` union change, provider, breaker wiring, key management for `metered_openrouter_bench` — referenced by name only) and per-token metered spend, to reach the *same model* (`gpt-5.5` — OpenRouter offers nothing stronger usable: `gpt-5.6-sol` is preview/partner-gated and NOT on OpenRouter).

**Revisit trigger (named, measurable — Close the Loop):** IF a future INSTAR-Bench pass measures the codex exec door against a clean OpenAI door on review-shaped tasks AND finds a ≥5-point door penalty, this decision reopens as an operator-approved follow-up. Until then the codex door stands. (Tracked deferral, §8.)

**Availability honesty:** codex-cli is per-machine (binary + `~/.codex/auth.json`). Detection already degrades gracefully where it is missing; nothing in this spec changes OpenAI-side behavior at all.

### §3 Google — KEEP the gemini-cli OAuth door on gemini-3.1-pro-preview; paid-key adapter DEFERRED behind a measurable trigger (DQ3 resolved)

**§3.1 The model bump already landed.** PR #1364 (merged, main) moved the gemini `capable` tier to `gemini-3.1-pro-preview` in `src/providers/adapters/gemini-cli/models.ts`, under the strict freshness lint. The gemini reviewer resolves through that tier map, so the "strongest usable Google model" half of the goal is **done** — this spec adds no Google model change.

**§3.2 The door's real defect is timeouts, and the first fix is a budget, not an adapter.** The gemini external reviewer degraded on timeout in every round of the two most recent convergences. Two confounded causes: (a) the reviewer call's timeout budget vs. 3.1-pro-preview's reasoning-token burn (the routing registry's hard rule 4 documents this model burning 5× budgets *thinking*); (b) free-OAuth-door capacity. Cause (a) is addressable for free: this spec adds `specConverge.reviewers.timeoutMs` (default = current behavior; recommended raise for review calls: 600s — a spec review is the least latency-sensitive LLM call in the system). Only if the raised budget still yields chronic timeouts is (b) implicated.

**§3.3 The paid-Gemini-key adapter is DEFERRED, not declined.** Unlike OpenRouter, a paid Google key (`metered_gemini_bench` — name only) reaches a **first-party** endpoint, so it does not break the egress invariant — it is merely a new adapter + metered spend that we may not need. **Trigger (named, measurable):** if, AFTER the timeout raise ships, the gemini family records `degraded` on **every round of 3 consecutive convergences** (read from the convergence reports / framework-activation history — no new watcher is built, see §Standard-B note), building the paid-key adapter becomes an operator-approval follow-up. (Tracked deferral, §8.)

### §4 The six internal reviewers — stay on the harness, strongest model via session escalation (DQ resolved for the internal bench)

The internal reviewers are Task subagents with **tools** — they Read/Grep the repo to verify a spec's claims against code. That grounding is load-bearing (round-grounded findings like "SourceTreeGuard does NOT intercept a job's Edit/Write" come from tool use, not from prose). Moving them to a tool-less one-shot clean door would trade a measured-elsewhere penalty for a certain capability loss. Additionally, the bench penalty is specific to **bounded verdict-shaped** work (strict-JSON gates); long-form multi-finding review with tool grounding is nature-C work, where the harness door has no measured penalty.

**Decision D7:** the internal six remain harness subagents. The strongest-model path for them is the **existing** `models.tierEscalation` spec-converge trigger (session → `claude-fable-5`), which also cascades to subagents. The skill documentation (SKILL.md) gains one line making this explicit: *run convergence in an escalation-eligible session; the round log records the session model per round* — disclosure, not a gate (a quota-refused escalation must never block a convergence).

### §5 Cross-model semantics guard — the claude family must never launder the flag

Claude reviewing a Claude-authored spec is a **clean-door second read, not a cross-model opinion**. Structural guarantees (typed, unit-tested — never prose):

1. `SupportedReviewerFramework` gains `crossFamily: boolean` (codex `true`, gemini `true`, claude `false`).
2. `aggregateRoundOutcomes` counts **only `crossFamily: true`** outcomes toward the spec-level `cross-model-review` flag. A convergence where only the claude family succeeded aggregates to `degraded-all-rounds`/`unavailable` exactly as today — the ⚠ banner semantics are unchanged and unlaunderable. The claude pass is recorded in a NEW, separate disclosure field: `clean-door-anthropic-review: claude-code:<model>` (or `degraded`/`not-run`).
3. `detectCrossModelReviewer` (the back-compat single-reviewer path) iterates only `crossFamily: true` entries — it can never select claude.
4. `wasNonClaudeFrameworkActiveWithin` and the activation-history recording are keyed on `crossFamily: true` families only — the claude family's availability can neither create nor satisfy the 7-day externals-mandatory baseline.
5. The `--family claude-code` script path is accepted (trusted allowlist, §1) but its `ReviewerResult.flag` renders as `clean-door-anthropic-review: …`, never `cross-model-review: …` — a copy-paste of the flag into frontmatter cannot forge the cross-model field.

### §6 Signal vs. Authority

Unchanged: every reviewer (internal, external, clean-door) is a **signal** into the convergence synthesis. No pass gains blocking authority; a degraded/unavailable family degrades loudly and convergence proceeds under the existing disclosure rules. The config gate (§1.5) gates *availability of a signal source*, not any authority.

### §7 Cost, bounds, and blast radius

- **Volume bound:** ≤1 claude-family call per round × ≤10 rounds per convergence; delta-gating (unchanged body → externals skipped) applies to the claude family identically.
- **Spend:** Fable 5 rides the subscription/Agent-SDK path via `buildIntelligenceProvider` — no new metered spend; quota pressure surfaces through the existing per-framework circuit breaker and `GET /subscription-pool` quota reads. A breaker-open round records `degraded: rate-limited` (existing semantics).
- **Concurrency:** the host spawn-cap funnel bounds the call like every other LLM spawn (Bounded Blast Radius).
- **Timeout:** `specConverge.reviewers.timeoutMs` clamps every family's call (min 30s, max 900s, absent = current defaults).

### Decision points touched

- `SUPPORTED_REVIEWER_FRAMEWORKS` — one new entry, config-gated off by default; codex remains preference leader; ordering among existing entries unchanged.
- `TRUSTED_REVIEWER_FRAMEWORKS` — gains `'claude-code'`. pi-cli remains banned; the first-party-only invariant is restated in the constant's doc comment as the *reason OpenRouter is not here*.
- `aggregateRoundOutcomes` / `detectCrossModelReviewer` / `wasNonClaudeFrameworkActiveWithin` — gain `crossFamily` filtering (behavior for existing families byte-identical; unit-locked).
- No block/allow gate, no HTTP route, no scheduler job, no watcher is introduced or modified.

### Multi-machine posture

- **Reviewer availability (which families detect on this machine)** — machine-local BY DESIGN.
  machine-local-justification: physical-credential-locality — each family's door is a per-disk CLI login (claude OAuth config-home, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`); reachability cannot replicate without replicating credentials, which is forbidden.
- **`state/framework-activation-history.jsonl`** — existing surface, unchanged; already machine-local for the same reason (it records THIS machine's detections).
  machine-local-justification: physical-credential-locality — it is a record of per-disk login availability.
- **Config (`specConverge.reviewers.*`)** — ordinary per-agent config in `.instar/config.json`; rides the existing config replication posture (no new state surface).
- Convergence itself runs on one machine per run (a skill invocation in one session); no cross-machine notice, URL, or durable-topic surface is added.

### Standard-B note (Self-Heal Before Notify) — explicitly n/a

This spec adds **no monitor, watcher, or recurring notice source**. The §3.3 trigger is evaluated by a human (or the convergence-running agent) reading existing convergence reports at the next convergence — there is no cadenced job, no attention-queue item, no escalation path. Degraded reviewer rounds surface where they always have: in the per-spec convergence report banner.

### Security considerations

- **Egress:** spec text already flows to Anthropic (the authoring session), OpenAI (codex reviewer), Google (gemini reviewer). The claude family adds **zero new egress destinations**. OpenRouter is declined partly on exactly this axis (§2.2).
- **Trust allowlist:** extended only with a first-party OAuth CLI — the invariant ("no custom/base-URL endpoint may receive spec text") is preserved and its doc comment strengthened.
- **Prompt injection:** reviewer output remains untrusted data parsed by `parseReviewerReply` and folded as findings — never executed, never instructions. Unchanged.
- **Secrets:** no new keys, no key material in config (the model override is a model id string). Vault names referenced in this spec (`metered_gemini_bench`, `metered_openrouter_bench`) appear by NAME only and only in deferral rationale.
- **Config-flip abuse:** flipping `anthropic.enabled` adds a signal source; it cannot alter the cross-model flag (§5) or any gate. Flipping it off mid-convergence is the existing "mid-converge deactivation" case only for crossFamily families; for the claude family a mid-run flip simply records `clean-door-anthropic-review: not-run` for later rounds — logged in the iteration log.

### Testing (three tiers — Testing Integrity Standard)

- **Unit** (`tests/unit/`): claude-family detection (injectable inputs: binary present/absent, config-home present/absent); model resolution (default pin, config override, canary rejection of tier words); `crossFamily` filtering in `aggregateRoundOutcomes` (a claude-only success must NOT produce a clean cross-model flag), `detectCrossModelReviewer` (never selects claude), activation-history recording (claude detections excluded from the non-Claude baseline); config gate default-off (absent config → registry accessors return `[codex, gemini]` exactly).
- **Integration** (`tests/integration/`): `cross-model-review.mjs --family claude-code` with a stubbed provider — accepted by the trusted allowlist, emits `clean-door-anthropic-review` flag shape; `--detect-only` output carries the new family only when enabled.
- **E2E / liveness:** the dogfood proof — the first dev-agent convergence after the flip runs three families and the convergence report shows the `clean-door-anthropic-review` line (recorded in the rollout checklist, inc3). No HTTP route exists to E2E-probe; the report artifact is the "feature is alive" evidence.
- **Wiring integrity:** the registry entry's provider construction asserted non-null under an enabled config in unit tests.

### Migration parity

- New config block `specConverge.reviewers` — **absent-safe defaults in code** (no `migrateConfig` entry needed; absence = today's behavior). No settings.json hooks, no CLAUDE.md template section (this is instar-developing-agent tooling, not an end-user capability — Agent Awareness satisfied by the SKILL.md update in the same increment), no hook scripts, no built-in skills content change beyond `skills/spec-converge/SKILL.md` prose (which ships with the repo, not via PostUpdateMigrator).
- The freshness-manifest edit rides the same PR (lint is strict; CI enforces coherence).

## Frontloaded Decisions

- **D1 (OpenAI door):** gpt-5.5 stays on the codex-cli subscription door. OpenRouter adapter DECLINED (penalty measured elsewhere; egress invariant; cost/surface). Revisit trigger: a measured ≥5-pt codex-door penalty on review-shaped bench tasks.
- **D2 (Anthropic door):** add the `claude-code` reviewer family via the existing `ClaudeCliIntelligenceProvider` — no new adapter, no union change. Ships dark behind `specConverge.reviewers.anthropic.enabled` (default false); live on the development agent first.
- **D3 (Anthropic model):** default pin `claude-fable-5` (constant + freshness-manifest registration), config-overridable, `isConcreteReviewerModel`-guarded, **no silent fallback** — unavailability degrades loudly.
- **D4 (cross-model honesty):** `crossFamily: false` for the claude family; aggregate flag, single-reviewer path, and the 7-day mandatory-check baseline all filter on `crossFamily: true`. The claude pass gets its own disclosure field `clean-door-anthropic-review`.
- **D5 (Google door):** stay on gemini-cli OAuth; model bump to `gemini-3.1-pro-preview` already landed (PR #1364); this spec makes no Google model change.
- **D6 (Google timeout-first):** add `specConverge.reviewers.timeoutMs` (absent = current defaults; clamp 30–900s); recommended 600s for review calls. This is the cheap fix tried BEFORE any paid door.
- **D7 (internal six):** remain harness Task subagents (tool grounding is load-bearing; the penalty is measured on bounded verdicts, not tool-grounded long-form review). Strongest-model path = existing `models.tierEscalation` spec-converge trigger; SKILL.md discloses the session model per round.
- **D8 (paid-Gemini-key adapter):** DEFERRED behind the measurable trigger (3 consecutive convergences with all-round gemini degradation AFTER the timeout raise) + operator approval. First-party endpoint, so trust-compatible when justified.
- **D9 (claude detection semantics):** binary + config-home presence = available; auth/entitlement failures surface at invocation as `degraded` with the classified reason.
- **D10 (reversibility):** every change is behind the config gate or byte-identical-by-default code paths; rollback = config flip (or revert of a docs/constants-only PR). No data migration, no durable state, no external side-effects.

## Cheap-to-change-after tags

- `timeoutMs` default/clamp values — **cheap-to-change-after** (a dark config knob read per invocation; no persistence, no interface).
- The §3.3 trigger threshold (3 consecutive convergences) — **cheap-to-change-after** (a documented decision rule for humans, not code; changing it edits prose in this spec + the deferral record).
- The `clean-door-anthropic-review` field NAME — **cheap-to-change-after** while dark (it appears in reports/frontmatter only once the family is enabled on the dev agent; renaming before fleet exposure is a grep-scale edit).

## Rollout increments

- **inc1 — the family, dark (code + tests).** `detectClaudeReviewer`, the registry entry with `crossFamily`, model resolution + manifest registration, trusted-allowlist extension, aggregate/single-path/baseline filtering, config gate (default off), unit + integration tests. Fleet behavior byte-identical.
- **inc2 — timeout knob.** `specConverge.reviewers.timeoutMs` threaded through all three families' invocations (absent = today's defaults). Fleet behavior byte-identical when absent.
- **inc3 — dev-agent flip + dogfood.** Enable `anthropic.enabled` on the development agent; the next real convergence runs three families; verify the report carries `clean-door-anthropic-review: claude-code:claude-fable-5` and the cross-model flag semantics are untouched; record the SKILL.md session-model disclosure line. Soak across ≥2 convergences.
- **inc4 — operator decision point.** Present dogfood evidence; operator chooses fleet posture for the flag (stay dev-only is a valid steady state — this is instar-dev tooling). The two deferrals (§8) remain tracked regardless.

## §8 Tracked deferrals (Close the Loop)

1. **Paid-Gemini-key reviewer door** — deferred behind D8's trigger; registered as an evolution action at inc1 merge (`ACT-…`, commitTo: evaluate at trigger).
2. **OpenRouter door for OpenAI** — declined with D1's revisit trigger; recorded in `docs/LLM-ROUTING-REGISTRY.md` Risk items so the bench team can see the standing question.
3. **Bench the `claude -p` door directly** (§1.1 honesty bound) — a candidate INSTAR-Bench v3 task; registered alongside 1.
4. **SelfHealGate runtime application** — n/a here (no watcher); noted only to be explicit that this spec does not claim it.

## Open questions

*(none — all decisions frontloaded above)*
